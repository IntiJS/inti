/**
 * Errors every adapter throws, so a page can tell "this does not exist" from
 * "the CMS cannot answer right now".
 *
 * The difference decides the status code, and the status code decides what a
 * search engine does: a 404 removes the page from the index, a 503 with
 * `Retry-After` asks it to come back later. Answering 404 because the CMS
 * timed out deindexes a page that exists.
 *
 * Checks go by `code`, not `instanceof`: two copies of `@intijs/core` (a
 * linked package, a monorepo) each have their own classes.
 */

export type IntiErrorCode = 'not_found' | 'unavailable' | 'unauthorized' | 'conflict' | 'http';

export class IntiError extends Error {
    readonly code: IntiErrorCode;
    constructor(code: IntiErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'IntiError';
        this.code = code;
    }
}

/** The thing asked for does not exist. A page answers 404 */
export class NotFoundError extends IntiError {
    /** What was looked up: `'page'`, `'product'`… */
    readonly resource: string;
    readonly key: string;
    constructor(resource: string, key: string, message?: string) {
        super('not_found', message ?? `No ${resource} "${key}".`);
        this.name = 'NotFoundError';
        this.resource = resource;
        this.key = key;
    }
}

/**
 * The source cannot answer now: a timeout, a network error, a 5xx, a 429.
 * A page answers 503 with `Retry-After`.
 */
export class UnavailableError extends IntiError {
    /** Seconds the source asked to wait, when it said */
    readonly retryAfter?: number;
    readonly status?: number;
    readonly url?: string;
    constructor(message: string, options: { retryAfter?: number; status?: number; url?: string; cause?: unknown } = {}) {
        super('unavailable', message, { cause: options.cause });
        this.name = 'UnavailableError';
        this.retryAfter = options.retryAfter;
        this.status = options.status;
        this.url = options.url;
    }
}

/** The source said "slow down" (429). It is a kind of unavailable */
export class RateLimitError extends UnavailableError {
    constructor(message: string, options: { retryAfter?: number; url?: string } = {}) {
        super(message, { ...options, status: 429 });
        this.name = 'RateLimitError';
    }
}

/** 401 or 403: the credentials are missing, wrong or not enough */
export class UnauthorizedError extends IntiError {
    readonly status: number;
    readonly url?: string;
    constructor(message: string, options: { status: number; url?: string }) {
        super('unauthorized', message);
        this.name = 'UnauthorizedError';
        this.status = options.status;
        this.url = options.url;
    }
}

/**
 * 409 or 412: what was written against changed in the meantime. The editor
 * says "someone else changed this" instead of overwriting their work.
 */
export class ConflictError extends IntiError {
    readonly status: number;
    readonly url?: string;
    constructor(message: string, options: { status: number; url?: string }) {
        super('conflict', message);
        this.name = 'ConflictError';
        this.status = options.status;
        this.url = options.url;
    }
}

/** Any other answer that is not a success (400, 422…) */
export class HttpError extends IntiError {
    readonly status: number;
    readonly url?: string;
    /** The start of the body, for the message: never the whole thing */
    readonly body?: string;
    constructor(message: string, options: { status: number; url?: string; body?: string }) {
        super('http', message);
        this.name = 'HttpError';
        this.status = options.status;
        this.url = options.url;
        this.body = options.body;
    }
}

const codeOf = (error: unknown): unknown =>
    error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;

export const isNotFound = (error: unknown): error is NotFoundError => codeOf(error) === 'not_found';
export const isUnavailable = (error: unknown): error is UnavailableError => codeOf(error) === 'unavailable';
export const isUnauthorized = (error: unknown): error is UnauthorizedError => codeOf(error) === 'unauthorized';
export const isConflict = (error: unknown): error is ConflictError => codeOf(error) === 'conflict';

/** `Retry-After` in seconds, from a number of seconds or an HTTP date */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    return Math.max(0, Math.ceil((date - now) / 1000));
}
