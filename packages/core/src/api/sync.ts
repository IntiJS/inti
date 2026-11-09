import type { APIRoute } from 'astro';

import { resolveRealtimeBackplane } from '../plugins/index.js';
import { RealtimeHub, createLocalBackplane } from '../realtime/hub.js';
import { resolveEditorSession } from '../server/editor-session.js';
import { env } from '../server/write-adapter.js';

/**
 * Real-time collaboration endpoint (SSE).
 *
 * GET  → opens a document's stream
 * POST → publishes a change to the other editors of THAT document
 *
 * Both require an editor session outside development (server/editor-session).
 *
 * Without a shared backplane this only works within one process: with
 * several instances behind a load balancer, each one sees only its own
 * clients. `createValkeyBackplane` (@intijs/core/team) covers that case.
 */

let hub: RealtimeHub | null = null;

function getHub(): RealtimeHub {
    if (!hub) {
        hub = new RealtimeHub(resolveRealtimeBackplane() ?? createLocalBackplane());
    }
    return hub;
}

/**
 * The stream exposes content changes, so it is same-origin by
 * default. It only opens to another origin if declared explicitly.
 */
function corsHeaders(): Record<string, string> {
    const origin = env('INTI_REALTIME_ALLOWED_ORIGIN');
    return origin
        ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' }
        : {};
}

/**
 * Listening or publishing requires an editor session (see server/editor-session).
 * Without it, anyone could read what is being edited or slip fake changes
 * onto the connected editors' screens.
 */
async function denyWithoutSession(
    request: Request,
    cookies: unknown,
    documentId?: string
): Promise<Response | null> {
    const session = await resolveEditorSession({ request, cookies, documentId });
    if (session.allowed) return null;
    return new Response(JSON.stringify({ error: session.reason }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
}

export const GET: APIRoute = async ({ request, cookies }) => {
    const url = new URL(request.url);
    const documentId = url.searchParams.get('docId');
    const clientId = url.searchParams.get('clientId') || crypto.randomUUID();

    if (!documentId) {
        return new Response('Missing docId', { status: 400 });
    }

    const denied = await denyWithoutSession(request, cookies, documentId);
    if (denied) return denied;

    const encoder = new TextEncoder();
    let leave: (() => void) | null = null;

    const stream = new ReadableStream({
        async start(controller) {
            const deliver = (frame: string) => controller.enqueue(encoder.encode(frame));

            leave = await getHub().join(documentId, clientId, deliver);

            deliver(`data: ${JSON.stringify({ type: 'connected', clientId, documentId })}\n\n`);
        },
        cancel() {
            leave?.();
            leave = null;
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...corsHeaders()
        }
    });
};

export const POST: APIRoute = async ({ request, cookies }) => {
    // JSON only: it forces a CORS preflight on cross-origin requests, so a
    // third party's form cannot publish with the editor's cookies
    // (text/plain and form-urlencoded stop here).
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        return new Response(JSON.stringify({ error: 'Content-Type must be application/json' }), {
            status: 415,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
    }

    try {
        const { docId, clientId, type, data } = await request.json();

        if (!docId || !clientId) {
            return new Response(JSON.stringify({ error: 'docId and clientId are required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const denied = await denyWithoutSession(request, cookies, docId);
        if (denied) return denied;

        await getHub().publish({
            documentId: docId,
            senderId: clientId,
            type: type ?? 'update',
            data
        });

        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({ error: `Failed to broadcast: ${message}` }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
};
