/**
 * POST /api/inti/generate
 *
 * Generates a block proposal for the editor and sends it block by block, one
 * JSON line per event. It writes nothing to the CMS: that only happens when the
 * editor accepts the proposal, through the usual action.
 */

import type { APIRoute } from 'astro';
import { hasWriteGuard, resolveBlockGenerator } from '../plugins/index.js';
import type { GeneratorBlockType } from '../plugins/index.js';
import { checkWriteAccess } from '../server/access.js';
import { resolveEditorSession } from '../server/editor-session.js';

export const prerender = false;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, cookies }) => {
    if (!/application\/json/.test(request.headers.get('content-type') ?? '')) {
        return json({ error: 'Expected application/json' }, 415);
    }

    // Every call spends the customer's key: without a guard, an open bill
    const session = await resolveEditorSession({ request, cookies });
    if (!session.allowed) return json({ error: session.reason }, 401);

    const access = checkWriteAccess('generateBlocks', hasWriteGuard());
    if (!access.allowed) return json({ error: access.reason }, 403);

    const generator = resolveBlockGenerator();
    if (!generator) return json({ available: false }, 501);

    const body = await request.json().catch(() => null);
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const blockTypes: GeneratorBlockType[] = Array.isArray(body?.blockTypes) ? body.blockTypes : [];
    const max = Number.isInteger(body?.max) ? Math.min(Math.max(body.max, 1), 20) : undefined;

    if (!prompt.trim() || blockTypes.length === 0) {
        return json({ error: 'A prompt and at least one block type are required.' }, 400);
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

            try {
                if (generator.stream) {
                    for await (const event of generator.stream(prompt, blockTypes, { max })) send(event);
                } else {
                    const result = await generator.generate(prompt, blockTypes, { max });
                    for (const message of result.warnings) send({ type: 'warning', message });
                    result.blocks.forEach((block, index) => {
                        send({ type: 'block', index, block, rendered: result.rendered?.[index] ?? block });
                    });
                    send({ type: 'done', count: result.blocks.length });
                }
            } catch (error) {
                send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            }

            controller.close();
        }
    });

    return new Response(stream, {
        headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' }
    });
};
