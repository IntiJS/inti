/**
 * Is whoever makes this request an editor?
 *
 * `access.ts` protects the writes, but the editor has more surface than
 * the actions:
 *
 * - `/api/inti/sync` broadcasts changes among the connected editors.
 *   Without any check, anyone can listen to what is being edited or inject
 *   fake changes into an editor's screen.
 * - `/api/inti/search` queries the CMS with the server's credentials.
 * - The editing pieces (block bar, panels, JSON of hidden blocks) are
 *   rendered into the page and add weight.
 *
 * There is a single rule for all of that:
 *
 *   development → yes
 *   a `resolveActor` plugin identifies someone → yes
 *   INTI_ALLOW_ANONYMOUS_WRITES set → yes (deliberate opt-in)
 *   any other case → no
 *
 * Unlike writes, here it is not enough for a guard to be registered: a
 * `beforeWrite` decides about one specific write, but it does not say who
 * is looking. Opening the editor requires an actor.
 */

import { resolveActor, getIntiPlugins, type Actor } from '../plugins/index.js';
import { ANONYMOUS_WRITES_ENV, isDevelopmentRuntime } from './access.js';
import { env } from './write-adapter.js';

export interface EditorSessionInput {
    isDevelopment: boolean;
    actor: Actor | null;
    allowAnonymous: boolean;
}

export interface EditorSessionDecision {
    allowed: boolean;
    actor: Actor | null;
    reason?: string;
}

const DENIAL_REASON =
    'Inti requires an editor session in production. Register a plugin with ' +
    '`resolveActor` (see @intijs/core/plugins), ' +
    `or set ${ANONYMOUS_WRITES_ENV}=1 to open editing to anyone deliberately.`;

/** Pure function: all environment reading happens in `resolveEditorSession` */
export function evaluateEditorSession(input: EditorSessionInput): EditorSessionDecision {
    if (input.isDevelopment) return { allowed: true, actor: input.actor };
    if (input.actor) return { allowed: true, actor: input.actor };
    if (input.allowAnonymous) return { allowed: true, actor: null };
    return { allowed: false, actor: null, reason: DENIAL_REASON };
}

function isTruthy(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export interface EditorSessionRequest {
    request?: Request;
    cookies?: unknown;
    /** Document being asked about, if known */
    documentId?: string;
    /**
     * Prerendered page: anyone receives the resulting HTML, so outside
     * development it never includes the editor, session or not.
     */
    prerendered?: boolean;
}

let warnedNoResolver = false;

/**
 * One-time warning: an editor session is requested in production and no
 * plugin is able to identify anyone.
 *
 * It almost always means the plugin is registered in `src/actions/index.ts`.
 * Astro only loads that module when the first request to an action
 * arrives, so until then the plugin does not exist: the editor does not
 * appear, and without the editor nobody can trigger that first action.
 */
function warnIfNoResolver(): void {
    if (warnedNoResolver) return;
    if (getIntiPlugins().some((plugin) => plugin.resolveActor)) return;
    warnedNoResolver = true;
    console.warn(
        '[inti] An editor session was requested and no registered plugin declares `resolveActor`. ' +
            'If you register it in src/actions/index.ts, move it to src/middleware.ts: Astro only loads the ' +
            'actions module with the first action, and until then nobody has a session.'
    );
}

/** Meant for tests: resets the one-time warning */
export function resetEditorSessionWarnings(): void {
    warnedNoResolver = false;
}

export async function resolveEditorSession(input: EditorSessionRequest = {}): Promise<EditorSessionDecision> {
    const isDevelopment = isDevelopmentRuntime();
    const allowAnonymous = isTruthy(env(ANONYMOUS_WRITES_ENV));

    if (input.prerendered && !isDevelopment) {
        return { allowed: false, actor: null, reason: 'Prerendered pages never include the editor outside development.' };
    }

    if (!isDevelopment && !allowAnonymous) warnIfNoResolver();

    // In dev nobody is asked: it is not needed and saves work per page
    const actor = isDevelopment
        ? null
        : await resolveActor({
              operation: 'session',
              documentId: input.documentId ?? '',
              request: input.request,
              cookies: input.cookies
          });

    return evaluateEditorSession({ isDevelopment, actor, allowAnonymous });
}
