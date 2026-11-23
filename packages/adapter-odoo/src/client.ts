/**
 * Talking to Odoo: the JSON-2 API (Odoo 19+), with JSON-RPC for older servers.
 *
 * JSON-2 is `POST /json/2/<model>/<method>` with the method's arguments by name, an API key as
 * `Authorization: bearer`, and the database in `X-Odoo-Database`. Odoo 17 and 18 do not have
 * it: there the client uses `POST /jsonrpc` (`object.execute_kw`), which needs the login of the
 * key's user. With `protocol: 'auto'` (the default) it tries JSON-2 once and remembers what
 * the server speaks.
 *
 * Requests go through the core's HTTP client: a time limit, typed errors, and reads resent once
 * after a dropped connection. Odoo's own error (`{ name, message }`) becomes the message.
 */

import { HttpError, UnauthorizedError, isNotFound, isUnauthorized } from '@intijs/core/errors';
import { createHttpClient, type HttpClient } from '@intijs/core/http';

import { staticKey, type OdooKeyStore } from './keys.js';

export type OdooDomain = Array<string | [string, string, unknown]>;

export interface OdooClientOptions {
    /** Origin of the Odoo server, e.g. https://erp.example.com */
    url: string;
    /** Database name. Required when the server hosts several */
    database?: string;
    /** An API key, or a store that hands out the current one and survives rotation */
    apiKey: string | OdooKeyStore;
    /** `json2` (Odoo 19+), `jsonrpc` (older), or `auto`. Default `auto` */
    protocol?: 'auto' | 'json2' | 'jsonrpc';
    /** Login of the key's user: only JSON-RPC needs it */
    login?: string;
    /** Milliseconds per request. Default 15000 */
    timeoutMs?: number;
    /** Context for every call: `{ lang: 'es_ES', pricelist: 3 }` */
    context?: Record<string, unknown>;
    fetch?: typeof fetch;
}

export interface CallOptions {
    /** Record ids for a method of records (`read`, `action_confirm`) */
    ids?: number[];
    context?: Record<string, unknown>;
    /** The call only reads: it may be resent after a dropped connection */
    read?: boolean;
}

export interface OdooClient {
    /** Any public model method, arguments by name */
    call<T = unknown>(model: string, method: string, kwargs?: Record<string, unknown>, options?: CallOptions): Promise<T>;
    searchRead<T = Record<string, unknown>>(
        model: string,
        domain: OdooDomain,
        fields: string[],
        options?: { limit?: number; offset?: number; order?: string; context?: Record<string, unknown> }
    ): Promise<T[]>;
    searchCount(model: string, domain: OdooDomain, options?: { context?: Record<string, unknown> }): Promise<number>;
    read<T = Record<string, unknown>>(model: string, ids: number[], fields: string[], options?: { context?: Record<string, unknown> }): Promise<T[]>;
    /** Field definitions of a model: what this server has installed */
    fieldsGet(model: string, attributes?: string[]): Promise<Record<string, { type: string; string?: string; relation?: string; store?: boolean }>>;
    /** The protocol in use, once known */
    readonly protocol: 'json2' | 'jsonrpc' | 'unknown';
}

/** Odoo's error body, when there is one: `{ name, message }` (JSON-2) or `{ error: { data } }` (JSON-RPC) */
function odooMessage(error: unknown): string | undefined {
    const body = (error as { body?: string })?.body;
    if (!body) return undefined;
    try {
        const parsed = JSON.parse(body);
        return parsed?.message ?? parsed?.error?.data?.message ?? parsed?.error?.message;
    } catch {
        return undefined;
    }
}

export function createOdooClient(options: OdooClientOptions): OdooClient {
    const keys: OdooKeyStore = typeof options.apiKey === 'string' ? staticKey(options.apiKey) : options.apiKey;
    let protocol: 'json2' | 'jsonrpc' | 'unknown' = options.protocol && options.protocol !== 'auto' ? options.protocol : 'unknown';
    let uid: Promise<number> | null = null;

    const http: HttpClient = createHttpClient({
        name: 'odoo',
        baseUrl: options.url.replace(/\/+$/, ''),
        timeoutMs: options.timeoutMs ?? 15_000,
        headers: (): Record<string, string> => (options.database ? { 'X-Odoo-Database': options.database } : {}),
        fetch: options.fetch,
        // ETags are for GET; every Odoo call is a POST
        etag: false
    });

    async function json2<T>(model: string, method: string, kwargs: Record<string, unknown>, call: CallOptions, retried = false): Promise<T> {
        const key = await keys.current();
        try {
            return await http.post<T>(`/json/2/${model}/${method}`, {
                json: {
                    ...kwargs,
                    ...(call.ids ? { ids: call.ids } : {}),
                    context: { ...options.context, ...call.context }
                },
                headers: { Authorization: `bearer ${key}` },
                idempotent: call.read,
                resource: `${model}.${method}`
            });
        } catch (error) {
            // A rotated key: the store may have the next one already
            if (isUnauthorized(error) && !retried && (await keys.next?.())) return json2(model, method, kwargs, call, true);
            throw withOdooMessage(error);
        }
    }

    async function jsonrpc<T>(service: string, method: string, args: unknown[], read = false): Promise<T> {
        const answer = await http.post<{ result?: T; error?: { message?: string; data?: { name?: string; message?: string } } }>('/jsonrpc', {
            json: { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() },
            idempotent: read,
            resource: `${service}.${method}`
        });
        if (answer?.error) {
            const message = answer.error.data?.message ?? answer.error.message ?? 'Odoo error';
            const name = answer.error.data?.name ?? '';
            if (/AccessDenied|AccessError/.test(name)) throw new UnauthorizedError(`odoo: ${message}`, { status: 403 });
            throw new HttpError(`odoo: ${message}`, { status: 422 });
        }
        return answer.result as T;
    }

    async function userId(): Promise<number> {
        if (!options.login) throw new Error('[odoo] JSON-RPC needs `login`: the user the API key belongs to (Odoo 18 or older).');
        if (!options.database) throw new Error('[odoo] JSON-RPC needs `database`.');
        uid ??= (async () => {
            const id = await jsonrpc<number | false>('common', 'authenticate', [options.database, options.login, await keys.current(), {}], true);
            if (!id) throw new UnauthorizedError('odoo: the login or the API key was refused', { status: 401 });
            return id;
        })().catch((error) => {
            uid = null;
            throw error;
        });
        return uid;
    }

    async function executeKw<T>(model: string, method: string, kwargs: Record<string, unknown>, call: CallOptions): Promise<T> {
        const id = await userId();
        const args = call.ids ? [call.ids] : [];
        const context = { ...options.context, ...call.context };
        return jsonrpc<T>('object', 'execute_kw', [options.database, id, await keys.current(), model, method, args, { ...kwargs, context }], call.read);
    }

    async function call<T>(model: string, method: string, kwargs: Record<string, unknown> = {}, callOptions: CallOptions = {}): Promise<T> {
        if (protocol === 'jsonrpc') return executeKw<T>(model, method, kwargs, callOptions);
        try {
            const result = await json2<T>(model, method, kwargs, callOptions);
            protocol = 'json2';
            return result;
        } catch (error) {
            // A server without JSON-2 answers 404 for /json/2: an Odoo older than 19
            if (protocol === 'unknown' && isNotFound(error) && options.protocol !== 'json2') {
                protocol = 'jsonrpc';
                return executeKw<T>(model, method, kwargs, callOptions);
            }
            throw error;
        }
    }

    return {
        get protocol() {
            return protocol;
        },
        call,
        searchRead: (model, domain, fields, o = {}) =>
            call(model, 'search_read', { domain, fields, limit: o.limit, offset: o.offset ?? 0, order: o.order }, { read: true, context: o.context }),
        searchCount: (model, domain, o = {}) => call<number>(model, 'search_count', { domain }, { read: true, context: o.context }),
        read: (model, ids, fields, o = {}) => call(model, 'read', { fields }, { ids, read: true, context: o.context }),
        fieldsGet: (model, attributes = ['type', 'string', 'relation', 'store']) =>
            call(model, 'fields_get', { attributes }, { read: true })
    };
}

/** Puts Odoo's own message in the error, which says what is wrong (a missing field, a rule) */
function withOdooMessage(error: unknown): unknown {
    const message = odooMessage(error);
    if (message && error instanceof Error && !error.message.includes(message)) {
        error.message = `${error.message.split(' — ')[0]} — ${message}`;
    }
    return error;
}
