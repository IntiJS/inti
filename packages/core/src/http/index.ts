/**
 * The HTTP client every adapter shares.
 *
 * Each adapter used to call `fetch` its own way: one retried a write after a
 * network error (and could apply it twice), another waited forever for a CMS
 * that hung, none read `Retry-After`. The rules live here once:
 *
 * - Every request has a time limit (`timeoutMs`).
 * - Only reads are retried (GET, HEAD), with backoff and jitter. A write that
 *   timed out may have been applied: retrying it could apply it twice.
 * - A 429 or a 503 waits for `Retry-After` when it is short, and fails at once
 *   with `RateLimitError` / `UnavailableError` when it is not.
 * - Reads send `If-None-Match` with the last `ETag` and reuse the body on a 304.
 * - Identical reads in flight at the same time share one request.
 * - Failures are typed (`@intijs/core/errors`), so the page decides 404 or 503
 *   by what happened, not by parsing a message.
 */

import {
    ConflictError,
    HttpError,
    NotFoundError,
    RateLimitError,
    UnauthorizedError,
    UnavailableError,
    parseRetryAfter
} from '../errors/index.js';

export interface HttpClientOptions {
    /** Prefix for relative paths */
    baseUrl?: string;
    /** Sent with every request. A function is called per request (rotating tokens) */
    headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
    /** Milliseconds before a request is abandoned. Default 10000 */
    timeoutMs?: number;
    /** Extra attempts for a read. Default 2 */
    retries?: number;
    /** First backoff, in milliseconds; it doubles per attempt. Default 250 */
    retryDelayMs?: number;
    /** Longest `Retry-After` worth waiting for inside a request, in seconds. Default 5 */
    maxRetryAfter?: number;
    /** Keep ETags and reuse bodies on 304. Default true */
    etag?: boolean;
    /** Bodies kept for revalidation. Default 500 */
    etagEntries?: number;
    /** Name in error messages: `wordpress: 503 at /wp/v2/pages` */
    name?: string;
    fetch?: typeof fetch;
    /** For tests: replaces the wait between attempts */
    sleep?: (ms: number) => Promise<void>;
}

export interface HttpRequestOptions {
    query?: Record<string, string | number | boolean | undefined | null>;
    headers?: Record<string, string>;
    /** Serialized as JSON, sent with `Content-Type: application/json` exactly */
    json?: unknown;
    /** Sent as is */
    body?: BodyInit;
    signal?: AbortSignal;
    /** Overrides the client's limit for this request */
    timeoutMs?: number;
    /** `false` turns off retries for this read */
    retry?: boolean;
    /**
     * A write that sends a final state (or carries a version check), so
     * sending it twice changes nothing. It is retried once after a dropped
     * connection — never after an answer. Servers close idle keep-alive
     * connections, and the first save after a pause otherwise fails.
     */
    idempotent?: boolean;
    /** What the 404 refers to, for `NotFoundError`. Default `'resource'` */
    resource?: string;
}

export interface HttpResult<T> {
    data: T;
    status: number;
    headers: Headers;
    /** The body came from the ETag store after a 304 */
    revalidated?: boolean;
}

export interface HttpClient {
    request<T = unknown>(method: string, path: string, options?: HttpRequestOptions): Promise<HttpResult<T>>;
    get<T = unknown>(path: string, options?: HttpRequestOptions): Promise<T>;
    post<T = unknown>(path: string, options?: HttpRequestOptions): Promise<T>;
    put<T = unknown>(path: string, options?: HttpRequestOptions): Promise<T>;
    patch<T = unknown>(path: string, options?: HttpRequestOptions): Promise<T>;
    delete<T = unknown>(path: string, options?: HttpRequestOptions): Promise<T>;
    /** Absolute URL of a path, with the query */
    url(path: string, query?: HttpRequestOptions['query']): string;
    /** Forgets stored ETags */
    clearEtags(): void;
}

const READS = new Set(['GET', 'HEAD']);
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

interface Stored {
    etag: string;
    data: unknown;
    status: number;
    headers: [string, string][];
}

function describe(name: string | undefined, status: number | string, url: string): string {
    let where = url;
    try {
        const parsed = new URL(url);
        where = parsed.pathname;
    } catch {
        // relative: keep it
    }
    return `${name ? `${name}: ` : ''}${status} at ${where}`;
}

async function parseBody(response: Response): Promise<unknown> {
    if (response.status === 204 || response.status === 304) return undefined;
    const text = await response.text();
    if (!text) return undefined;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('json') || /^[[{]/.test(text.trimStart())) {
        try {
            return JSON.parse(text);
        } catch {
            if (type.includes('json')) throw new HttpError(`Invalid JSON in response`, { status: response.status, url: response.url, body: text.slice(0, 300) });
        }
    }
    return text;
}

function errorFor(status: number, url: string, name: string | undefined, headers: Headers, body: string, resource: string) {
    const message = describe(name, status, url) + (body ? ` — ${body.slice(0, 200)}` : '');
    if (status === 404 || status === 410) return new NotFoundError(resource, url, message);
    if (status === 401 || status === 403) return new UnauthorizedError(message, { status, url });
    if (status === 409 || status === 412) return new ConflictError(message, { status, url });
    if (status === 429) return new RateLimitError(message, { retryAfter: parseRetryAfter(headers.get('retry-after')), url });
    if (status >= 500 || status === 408) {
        return new UnavailableError(message, { status, url, retryAfter: parseRetryAfter(headers.get('retry-after')) });
    }
    return new HttpError(message, { status, url, body: body.slice(0, 300) });
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
        signal: controller.signal,
        done: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    };
}


/** `Headers` as pairs; `entries()` needs the DOM.Iterable lib */
function headerPairs(headers: Headers): [string, string][] {
    const pairs: [string, string][] = [];
    headers.forEach((value, name) => pairs.push([name, value]));
    return pairs;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const retries = Math.max(0, options.retries ?? 2);
    const retryDelayMs = options.retryDelayMs ?? 250;
    const maxRetryAfter = options.maxRetryAfter ?? 5;
    const useEtag = options.etag !== false;
    const etagEntries = options.etagEntries ?? 500;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    const etags = new Map<string, Stored>();
    const inflight = new Map<string, Promise<HttpResult<unknown>>>();

    const url = (path: string, query?: HttpRequestOptions['query']) => {
        const absolute = /^https?:\/\//i.test(path)
            ? new URL(path)
            : new URL(path.replace(/^\/+/, ''), (options.baseUrl ?? '').replace(/\/?$/, '/'));
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== null) absolute.searchParams.set(key, String(value));
        }
        return absolute.toString();
    };

    const baseHeaders = async () =>
        typeof options.headers === 'function' ? await options.headers() : { ...(options.headers ?? {}) };

    function remember(key: string, stored: Stored) {
        etags.delete(key);
        etags.set(key, stored);
        while (etags.size > etagEntries) etags.delete(etags.keys().next().value as string);
    }

    async function attempt<T>(method: string, target: string, headers: Record<string, string>, request: HttpRequestOptions, key: string): Promise<HttpResult<T>> {
        const isRead = READS.has(method);
        const maxAttempts = isRead && request.retry !== false ? retries + 1 : request.idempotent ? 2 : 1;
        const fetchImpl = options.fetch ?? globalThis.fetch;
        let lastError: unknown;

        for (let index = 0; index < maxAttempts; index++) {
            const stored = isRead && useEtag ? etags.get(key) : undefined;
            const sent = { ...headers };
            if (stored && !Object.keys(sent).some((name) => name.toLowerCase() === 'if-none-match')) {
                sent['If-None-Match'] = stored.etag;
            }

            const { signal, done } = withTimeout(request.signal, request.timeoutMs ?? timeoutMs);
            let response: Response;
            try {
                response = await fetchImpl(target, {
                    method,
                    headers: sent,
                    body: request.json !== undefined ? JSON.stringify(request.json) : request.body,
                    signal
                });
            } catch (error) {
                done();
                if (request.signal?.aborted) throw error;
                const timedOut = (error as { name?: string })?.name === 'TimeoutError' || signal.aborted;
                lastError = new UnavailableError(
                    `${describe(options.name, timedOut ? 'timeout' : 'network error', target)}${timedOut ? ` after ${request.timeoutMs ?? timeoutMs} ms` : ''}`,
                    { url: target, cause: error }
                );
                if (index < maxAttempts - 1) {
                    await sleep(retryDelayMs * 2 ** index * (0.5 + Math.random() / 2));
                    continue;
                }
                throw lastError;
            }

            try {
                if (response.status === 304 && stored) {
                    return { data: stored.data as T, status: stored.status, headers: new Headers(stored.headers), revalidated: true };
                }

                if (response.ok) {
                    const data = (await parseBody(response)) as T;
                    const etag = response.headers.get('etag');
                    if (isRead && useEtag && etag && method === 'GET') {
                        remember(key, { etag, data, status: response.status, headers: headerPairs(response.headers) });
                    }
                    return { data, status: response.status, headers: response.headers };
                }

                const text = await response.text().catch(() => '');
                const error = errorFor(response.status, target, options.name, response.headers, text, request.resource ?? 'resource');
                lastError = error;

                if (isRead && index < maxAttempts - 1 && RETRYABLE.has(response.status)) {
                    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
                    if (retryAfter !== undefined && retryAfter > maxRetryAfter) throw error;
                    await sleep(retryAfter !== undefined ? retryAfter * 1000 : retryDelayMs * 2 ** index * (0.5 + Math.random() / 2));
                    continue;
                }
                throw error;
            } finally {
                done();
            }
        }
        throw lastError;
    }

    async function request<T>(method: string, path: string, request: HttpRequestOptions = {}): Promise<HttpResult<T>> {
        const verb = method.toUpperCase();
        const target = url(path, request.query);
        const headers: Record<string, string> = { Accept: 'application/json', ...(await baseHeaders()), ...(request.headers ?? {}) };
        if (request.json !== undefined) {
            for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-type') delete headers[name];
            headers['Content-Type'] = 'application/json';
        }

        // Headers are part of the key: two users' reads are not the same read
        const key = `${verb} ${target} ${JSON.stringify(Object.entries(headers).sort())}`;
        // A caller with its own signal may cancel: it does not share a request with anyone
        if (verb !== 'GET' || request.signal) return attempt<T>(verb, target, headers, request, key);

        const pending = inflight.get(key);
        if (pending) return pending as Promise<HttpResult<T>>;
        const promise = attempt<T>(verb, target, headers, request, key).finally(() => inflight.delete(key));
        inflight.set(key, promise as Promise<HttpResult<unknown>>);
        return promise;
    }

    const data = (method: string) => async <T>(path: string, options?: HttpRequestOptions) =>
        (await request<T>(method, path, options)).data;

    return {
        request,
        get: data('GET'),
        post: data('POST'),
        put: data('PUT'),
        patch: data('PATCH'),
        delete: data('DELETE'),
        url,
        clearEtags: () => etags.clear()
    };
}

export * from '../errors/index.js';
