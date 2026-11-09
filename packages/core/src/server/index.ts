/**
 * Inti's server-side entry point.
 *
 * Exposes write adapter resolution for consumers outside the Astro
 * runtime (CLI, MCP server), reusing the same environment variable
 * convention as the actions.
 */

export { env, resolveWriteAdapter } from './write-adapter.js';
export {
    assertWriteAccess,
    checkWriteAccess,
    evaluateWriteAccess,
    isDevelopmentRuntime,
    ANONYMOUS_WRITES_ENV
} from './access.js';
export type { WriteAccessInput, WriteAccessDecision } from './access.js';
export { resolveEditorSession, evaluateEditorSession } from './editor-session.js';
export type { EditorSessionInput, EditorSessionDecision, EditorSessionRequest } from './editor-session.js';
export { adaptPage } from './adapt-page.js';
export type { AdaptPageOptions, AdaptPageRequest, AdaptPageResult } from './adapt-page.js';
export { readDraftPage, DRAFT_PARAM } from './drafts.js';
export type { DraftPageRequest } from './drafts.js';
