/**
 * GET /api/inti/search?collection=posts&q=text
 *
 * Entry search for the inline editor's relation picker.
 * Response: plain JSON [{ id, title, subtitle? }]
 *
 * Uses the configured write adapter if it implements SearchableAdapter;
 * otherwise it offers no candidates.
 */

import type { APIRoute } from 'astro';
import { isSearchableAdapter } from '../adapters/index.js';
import { resolveEditorSession } from '../server/editor-session.js';
import { resolveWriteAdapter } from '../server/write-adapter.js';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ url, request, cookies }) => {
    // Queries the CMS with the server's credentials: editors only
    const session = await resolveEditorSession({ request, cookies });
    if (!session.allowed) {
        return json({ error: session.reason }, 401);
    }

    const collection = url.searchParams.get('collection') || '';
    const query = url.searchParams.get('q') || '';

    if (!collection) {
        return json({ error: 'Missing "collection" param' }, 400);
    }

    try {
        const adapter = await resolveWriteAdapter();

        // An adapter that cannot search simply offers no candidates
        return json(adapter && isSearchableAdapter(adapter) ? await adapter.searchEntries(collection, query) : []);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 500);
    }
};
