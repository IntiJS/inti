/**
 * Is this request from a Kitsuden editor?
 *
 * Inti has no users of its own: outside development it opens the editor only to whoever a
 * plugin with `resolveActor` identifies. This is that plugin for Kitsuden.
 *
 * The rule: forward the visitor's better-auth session cookies, and only those, to
 * `GET <api>/api/auth/get-session`; it counts only when the API answers 200 with a user whose
 * role is one of `roles` (default `admin`, `editor`). The site cannot validate the cookie
 * itself, so it never decides anything from it.
 *
 * - No session cookie → no request to the API at all.
 * - The role is read without better-auth's 5-minute cookie cache (`disableCookieCache`), so
 *   demoting someone takes effect on their next request, not five minutes later.
 * - Any failure (API down, odd answer, timeout) → not an editor.
 * - One question per request: the page, the toolbar and the actions ask for the same actor.
 *
 * The cookie only reaches the site when the browser sends it there: the site and the API must
 * share the host (any port of localhost in development) or a parent domain.
 */

export const DEFAULT_EDITOR_ROLES = ['admin', 'editor'] as const;

export interface KitsudenEditor {
    id: string;
    role: string;
    email?: string;
    name?: string;
}

const SESSION_COOKIE = /^(?:__Secure-|__Host-)?better-auth\.[A-Za-z0-9_.-]+$/;
const SESSION_TOKEN = /^(?:__Secure-|__Host-)?better-auth\.session_token=/;

/** The better-auth cookies of a `Cookie` header, or "" when there is no session token */
export function sessionCookies(header: string | null | undefined): string {
    if (!header) return '';
    const own = header
        .split(';')
        .map((part) => part.trim())
        .filter((part) => {
            const eq = part.indexOf('=');
            return eq > 0 && SESSION_COOKIE.test(part.slice(0, eq)) && part.length > eq + 1;
        });
    return own.some((part) => SESSION_TOKEN.test(part)) ? own.join('; ') : '';
}

/** The `get-session` body reduced to an editor, or `null` */
export function editorFromSession(body: unknown, roles: readonly string[] = DEFAULT_EDITOR_ROLES): KitsudenEditor | null {
    const user = (body as { user?: unknown } | null)?.user;
    if (!user || typeof user !== 'object') return null;
    const { id, role, email, name } = user as Record<string, unknown>;
    if (typeof id !== 'string' || !id) return null;
    if (typeof role !== 'string' || !roles.includes(role)) return null;
    return { id, role, ...(typeof email === 'string' ? { email } : {}), ...(typeof name === 'string' ? { name } : {}) };
}

export interface ResolveEditorOptions {
    /** Origin of the Kitsuden API as the server reaches it */
    api: string;
    roles?: readonly string[];
    fetch?: typeof fetch;
    /** Default 3000 */
    timeoutMs?: number;
}

export async function resolveEditor(cookieHeader: string | null | undefined, options: ResolveEditorOptions): Promise<KitsudenEditor | null> {
    const cookie = sessionCookies(cookieHeader);
    if (!cookie) return null;
    const base = options.api.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return null;
    try {
        const response = await (options.fetch ?? fetch)(`${base}/api/auth/get-session?disableCookieCache=true`, {
            headers: { cookie, accept: 'application/json' },
            redirect: 'manual',
            signal: AbortSignal.timeout(options.timeoutMs ?? 3000)
        });
        return response.status === 200 ? editorFromSession(await response.json(), options.roles) : null;
    } catch {
        return null;
    }
}

/** One answer per request, shared by everything that asks during it */
export function perRequest(
    resolver: (cookie: string | null) => Promise<KitsudenEditor | null>
): (request: Request | undefined) => Promise<KitsudenEditor | null> {
    const seen = new WeakMap<Request, Promise<KitsudenEditor | null>>();
    return (request) => {
        if (!request) return Promise.resolve(null);
        let pending = seen.get(request);
        if (!pending) {
            pending = resolver(request.headers.get('cookie'));
            seen.set(request, pending);
        }
        return pending;
    };
}

interface WriteContextLike {
    operation: string;
    request?: Request;
    actor?: unknown;
}

/**
 * The Inti plugin: identifies the editor AND refuses any write without one.
 *
 * The second half matters: for Inti a registered `resolveActor` is enough to consider writes
 * guarded, but `resolveActor` returning null does not stop them. Without `beforeWrite`, an
 * anonymous POST to `/_actions/inti.updateBlockField` would write with the server's agent key.
 */
export function kitsudenEditorPlugin(
    resolver: (request: Request | undefined) => Promise<KitsudenEditor | null>,
    roles: readonly string[] = DEFAULT_EDITOR_ROLES
) {
    return {
        name: 'kitsuden:editor',
        resolveActor: (ctx: WriteContextLike) => resolver(ctx.request),
        beforeWrite: async (ctx: WriteContextLike) => {
            const actor = ((ctx.actor as KitsudenEditor | null | undefined) ?? (await resolver(ctx.request))) as KitsudenEditor | null;
            return actor && roles.includes(actor.role)
                ? { allowed: true }
                : { allowed: false, reason: `A Kitsuden session with role ${roles.join(' or ')} is required.` };
        }
    };
}
