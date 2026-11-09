/**
 * Reads a page's draft for whoever is allowed to see it.
 *
 * Unpublished content must never reach a visitor: `?inti-draft=1` in the
 * URL is not enough, an editor session is required. It is read with the
 * write adapter because that is the one with credentials: the page's read
 * adapter is usually anonymous, and WordPress returns no drafts to anonymous users.
 */

import { isDraftableAdapter } from '../adapters/index.js';
import type { IntiPage } from '../types/index.js';
import { resolveEditorSession } from './editor-session.js';
import type { EditorSessionRequest } from './editor-session.js';
import { resolveWriteAdapter } from './write-adapter.js';

export const DRAFT_PARAM = 'inti-draft';

export interface DraftPageRequest extends EditorSessionRequest {
    url: URL;
    /** If given, the response is marked so neither CDNs nor search engines store it */
    response?: { headers: Headers };
}

/** The draft page, or null when it must not be shown: the case of every visitor */
export async function readDraftPage(slug: string, request: DraftPageRequest): Promise<IntiPage | null> {
    if (!request.url.searchParams.has(DRAFT_PARAM)) return null;

    const session = await resolveEditorSession(request);
    if (!session.allowed) return null;

    const adapter = await resolveWriteAdapter();
    if (!isDraftableAdapter(adapter)) return null;

    const draft = await adapter.fetchDraftBySlug(slug);
    if (draft && request.response) {
        request.response.headers.set('Cache-Control', 'private, no-store');
        request.response.headers.set('X-Robots-Tag', 'noindex');
    }
    return draft;
}
