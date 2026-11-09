#!/usr/bin/env node
/**
 * Checks @intijs/cloudflare in workerd, Cloudflare's real runtime, locally: a
 * create-inti project with @astrojs/cloudflare, and local D1, R2 and Durable Objects.
 * It needs no account and touches nothing remote.
 *
 * What it does not cover: Workers AI and Image Transformations, which only exist in the account.
 *
 * Usage: node scripts/cloudflare-check.mjs [--keep]   Requires `npm run build`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const win = process.platform === 'win32';
const PORT = 43500;
const BASE = `http://127.0.0.1:${PORT}`;
const EDITOR = { 'x-check-editor': '1' };

const PACKAGES = ['packages/core', 'packages/genui', 'packages/cloudflare', 'packages/create-inti'];

function pack(dir, destination) {
    const output = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], { cwd: join(ROOT, dir), encoding: 'utf8', shell: win });
    const json = JSON.parse(output.slice(output.search(/^\[\s*$/m)));
    return { name: json[0].name, path: join(destination, json[0].filename) };
}

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'], shell: win });

const FILES = {
    'astro.config.mjs': `import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import inti from '@intijs/core';

export default defineConfig({
    output: 'server',
    adapter: cloudflare({ imageService: 'passthrough', session: false }),
    integrations: [inti()]
});
`,
    'wrangler.jsonc': `{
    "name": "inti-check",
    "main": "./src/worker.ts",
    "compatibility_date": "2026-10-01",
    "compatibility_flags": ["nodejs_compat"],
    "d1_databases": [{ "binding": "DB", "database_name": "inti", "database_id": "00000000-0000-0000-0000-000000000000" }],
    "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "inti-media" }],
    "durable_objects": {
        "bindings": [
            { "name": "INTI_ROOM", "class_name": "IntiRoom" },
            { "name": "INTI_LIMITER", "class_name": "IntiLimiter" }
        ]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["IntiRoom", "IntiLimiter"] }]
}
`,
    'src/worker.ts': `import { handle } from '@astrojs/cloudflare/handler';
export { IntiRoom, IntiLimiter } from '@intijs/cloudflare/durable';

export default {
    fetch(request, env, ctx) {
        return handle(request, env, ctx);
    }
};
`,
    'src/middleware.ts': `import { env } from 'cloudflare:workers';
import { registerIntiPlugin } from '@intijs/core/plugins';
import { D1ContentAdapter, createD1ExperimentStore, createD1PatternStore, migrateD1 } from '@intijs/cloudflare';

let ready;

/** Once per instance: creates the tables and the sample page if they do not exist */
function prepare() {
    return (ready ??= (async () => {
        await migrateD1(env.DB);
        const adapter = new D1ContentAdapter(env.DB);
        await adapter.fetchPageBySlug('home').catch(() =>
            adapter.putDocument({
                id: 'home',
                slug: 'home',
                title: 'Home',
                seo: { title: 'Site on Cloudflare', description: 'Check' },
                blocks: [
                    { type: 'Hero', data: { heading: 'Default headline', inti_slot: 'hero' } },
                    { type: 'Hero', data: { heading: 'Mobile headline', inti_slot: 'hero', inti_audience: 'device:mobile' } },
                    { type: 'Text', data: { body: 'Always visible text' } }
                ]
            })
        );
    })());
}

registerIntiPlugin({
    name: 'check',
    resolveActor: (ctx) => {
        const request = ctx.request;
        const fromUrl = request ? new URL(request.url).searchParams.get('editor') === '1' : false;
        return fromUrl || request?.headers.get('x-check-editor') === '1' ? { id: 'editor-1', role: 'editor' } : null;
    },
    beforeWrite: (ctx) => ({ allowed: Boolean(ctx.actor) }),
    getWriteAdapter: () => new D1ContentAdapter(env.DB),
    getExperimentStore: () => createD1ExperimentStore(env.DB),
    getPatternStore: () => createD1PatternStore(env.DB)
});

export const onRequest = async (_ctx, next) => {
    await prepare();
    return next();
};
`,
    'src/lib/cms.ts': `import { env } from 'cloudflare:workers';
import { D1ContentAdapter } from '@intijs/cloudflare';

export const readPage = (slug: string) => new D1ContentAdapter(env.DB).fetchPageBySlug(slug);
`,
    'src/pages/[...slug].astro': `---
import Layout from '../layouts/Layout.astro';
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import VisualBridgeAuto from '@intijs/core/visual-bridge/VisualBridgeAuto.astro';
import { adaptPage, readDraftPage } from '@intijs/core/server';
import { readPage } from '../lib/cms';

registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const slug = Astro.params.slug ?? 'home';

let page;
try {
    page = (await readDraftPage(slug, Astro)) ?? (await readPage(slug));
} catch {
    return new Response('Page not found', { status: 404 });
}

const { blocks } = await adaptPage(page.blocks, Astro, { holdout: 0 });
---
<Layout page={page}>
    <BlockRenderer blocks={blocks} page={page} />
</Layout>
<VisualBridgeAuto enabled={true} />
`,
    'src/pages/api/room.ts': `import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { resolveEditorSession } from '@intijs/core/server';
import { connectToRoom } from '@intijs/cloudflare/durable';

export const GET: APIRoute = async ({ request, cookies, url }) => {
    const session = await resolveEditorSession({ request, cookies });
    if (!session.allowed) return new Response('No session', { status: 401 });
    return connectToRoom(env.INTI_ROOM, request, { documentId: url.searchParams.get('docId') ?? '', actorId: session.actor?.id });
};
`,
    'src/pages/api/upload.ts': `import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { resolveEditorSession } from '@intijs/core/server';
import { createR2MediaStore } from '@intijs/cloudflare';

export const POST: APIRoute = async ({ request, cookies }) => {
    const session = await resolveEditorSession({ request, cookies });
    if (!session.allowed) return new Response('No session', { status: 401 });

    const form = await request.formData();
    const result = await createR2MediaStore(env.MEDIA).upload(form.get('file') as File, { alt: String(form.get('alt') ?? '') });
    return Response.json(result, { status: result.ok ? 201 : result.status });
};

export const GET: APIRoute = async () => Response.json(await createR2MediaStore(env.MEDIA).asData());
`,
    'src/pages/media/[id].ts': `import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { createR2MediaStore } from '@intijs/cloudflare';

export const GET: APIRoute = ({ params }) => createR2MediaStore(env.MEDIA).serve(params.id ?? '');
`,
    'src/pages/search.astro': `---
import { env } from 'cloudflare:workers';
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import { createVisitorComposer, defineVocabulary, VISITOR_HEADERS } from '@intijs/genui';
import { createD1ComposeCache } from '@intijs/cloudflare';
import { createDurableLimiter } from '@intijs/cloudflare/durable';

export const partial = true;

registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const provider = {
    calls: 0,
    async generate() {
        return { blocks: [{ nativeType: 'Hero', data: { heading: 'Composed for the visit' } }] };
    }
};

const composer = createVisitorComposer({
    provider,
    limits: { perMinute: 2 },
    limiter: createDurableLimiter(env.INTI_LIMITER),
    cache: createD1ComposeCache(env.DB),
    vocabulary: defineVocabulary({ Hero: { fields: { heading: { type: 'string' } } } })
});

const result = await composer.compose(Astro.url.searchParams.get('q') ?? '', { visitorKey: Astro.request.headers.get('x-check-visitor') ?? 'anon' });

for (const [name, value] of Object.entries(VISITOR_HEADERS)) Astro.response.headers.set(name, value);
Astro.response.headers.set('X-Check-Status', result.status);
Astro.response.headers.set('X-Check-Cached', String(result.cached));
---
<BlockRenderer blocks={result.blocks.map((b) => ({ type: b.nativeType, data: b.data }))} editable={false} audit={false} />
`,
    'src/pages/image.astro': `---
import { cloudflareImageSrcset, cloudflareImageUrl } from '@intijs/cloudflare';
---
<img src={cloudflareImageUrl('/media/a.jpg', { width: 640 })} srcset={cloudflareImageSrcset('/media/a.jpg')} alt="" />
`
};

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const results = [];

async function check(name, run) {
    try {
        await run();
        results.push({ name, ok: true });
        console.log(`✓ ${name}`);
    } catch (error) {
        results.push({ name, ok: false });
        console.log(`✗ ${name}\n    ${error instanceof Error ? error.message : error}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const has = (html, text) => assert(html.includes(text), `missing "${text}" in:\n${html.slice(0, 500)}`);
const hasNot = (html, text) => assert(!html.includes(text), `unexpected "${text}"`);

const action = (name, body, headers = EDITOR) =>
    fetch(`${BASE}/_actions/inti.${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const page = (path = '/', headers = {}) => fetch(BASE + path, { headers }).then((r) => r.text());

/** A WebSocket client that keeps what it receives and can wait for a specific message */
function connect(query) {
    return new Promise((resolvePromise, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/room?${query}`);
        const received = [];
        const waiters = [];
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            received.push(message);
            for (const waiter of [...waiters]) {
                if (waiter.match(message)) {
                    waiters.splice(waiters.indexOf(waiter), 1);
                    waiter.resolve(message);
                }
            }
        });
        socket.addEventListener('open', () =>
            resolvePromise({
                socket,
                received,
                send: (message) => socket.send(JSON.stringify(message)),
                waitFor(match, ms = 5000) {
                    const seen = received.find(match);
                    if (seen) return Promise.resolve(seen);
                    return new Promise((res, rej) => {
                        const timer = setTimeout(() => rej(new Error(`the expected message never arrived; received: ${JSON.stringify(received).slice(0, 300)}`)), ms);
                        waiters.push({ match, resolve: (m) => { clearTimeout(timer); res(m); } });
                    });
                }
            })
        );
        socket.addEventListener('error', () => reject(new Error('could not open the WebSocket')));
    });
}

async function checks() {
    await check('the page is read from D1, in workerd, with no JavaScript for the visitor', async () => {
        const html = await page('/');
        has(html, 'Default headline');
        hasNot(html, 'Mobile headline');
        assert(!/<script[^>]*type="module"/.test(html), 'the visitor receives JavaScript');
        hasNot(html, 'data-inti-inline-editor');
    });

    await check('personalization is decided in the Worker', async () => {
        const response = await fetch(`${BASE}/`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Mobile' } });
        has(await response.text(), 'Mobile headline');
        assert(response.headers.get('cache-control')?.includes('private'), 'missing Cache-Control: private');
    });

    await check('the editor appears with a session, and an edit persists in D1', async () => {
        has(await page('/', EDITOR), 'data-inti-inline-editor');
        assert((await action('updateBlockField', { documentId: 'home', blockIndex: 2, field: 'body', value: 'x' }, {})).status === 403, 'an anonymous user can write');

        const saved = await action('updateBlockField', { documentId: 'home', blockIndex: 2, field: 'body', value: 'Edited in D1' });
        assert(saved.ok, `responds ${saved.status}: ${(await saved.text()).slice(0, 200)}`);
        has(await page('/'), 'Edited in D1');
    });

    await check('a dangerous dot-path is rejected', async () => {
        const response = await action('updateBlockField', { documentId: 'home', blockIndex: 2, field: '__proto__.x', value: 'y' });
        assert(!response.ok, 'accepted __proto__');
    });

    await check('concurrent writes do not overwrite each other', async () => {
        const responses = await Promise.all(
            Array.from({ length: 5 }, (_, i) => action('insertBlock', { documentId: 'home', index: 99, nativeType: 'Text', data: { body: `c${i}` } }))
        );
        assert(responses.every((r) => r.ok), `statuses: ${responses.map((r) => r.status)}`);
        const html = await page('/');
        for (let i = 0; i < 5; i++) has(html, `c${i}`);
    });

    await check('a draft in D1 is not visible until published', async () => {
        assert((await action('createDraft', { documentId: 'home' })).ok, 'create');
        assert((await action('updateBlockField', { documentId: 'home--draft', blockIndex: 2, field: 'body', value: 'Draft only' })).ok, 'edit');

        hasNot(await page('/'), 'Draft only');
        hasNot(await page('/?inti-draft=1'), 'Draft only');
        has(await page('/?inti-draft=1', EDITOR), 'Draft only');

        assert((await action('publishDraft', { documentId: 'home--draft' })).ok, 'publish');
        has(await page('/'), 'Draft only');
    });

    await check('R2: an image is uploaded and served; its type is decided by its bytes', async () => {
        const upload = (bytes, type, name, headers = EDITOR) => {
            const form = new FormData();
            form.set('file', new Blob([bytes], { type }), name);
            form.set('alt', 'One pixel');
            return fetch(`${BASE}/api/upload`, { method: 'POST', headers, body: form });
        };

        assert((await upload(PNG, 'image/png', 'a.png', {})).status === 401, 'an anonymous user can upload');

        const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
        assert((await upload(html, 'image/png', 'fake.png')).status === 415, 'accepts an HTML file with an image name');
        const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
        assert((await upload(svg, 'image/svg+xml', 'a.svg')).status === 415, 'accepts an SVG');

        const response = await upload(PNG, 'image/png', '../../evil.png');
        assert(response.status === 201, `responds ${response.status}`);
        const { item } = await response.json();
        assert(!item.id.includes('evil') && !item.id.includes('/'), `uses the uploaded name: ${item.id}`);

        const served = await fetch(BASE + item.url);
        assert(served.ok, `serving responds ${served.status}`);
        assert(served.headers.get('content-type') === 'image/png', served.headers.get('content-type'));
        assert(served.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
        assert(new Uint8Array(await served.arrayBuffer()).length === PNG.length, 'different bytes');

        const data = await (await fetch(`${BASE}/api/upload`)).json();
        assert(data.some((entry) => entry.id === item.id && entry.summary === 'One pixel'), 'does not show up as a data source');

        assert((await fetch(`${BASE}/media/..%2F..%2Fsecret`)).status === 404, 'accepts an odd key');
    });

    await check('Durable Object: a room fans out between editors, and whoever arrives catches up', async () => {
        const refused = await connect('docId=home&clientId=anon').then(() => false, () => true);
        assert(refused, 'a room opens without a session');

        const ana = await connect('docId=home&clientId=ana&editor=1');
        const luis = await connect('docId=home&clientId=luis&editor=1');
        const other = await connect('docId=other&clientId=other&editor=1');

        await ana.waitFor((m) => m.type === 'joined' && m.clientId === 'luis');

        ana.send({ type: 'update', blockIndex: 1, value: 'Hello', clientId: 'spoofed' });
        const update = await luis.waitFor((m) => m.type === 'update');
        assert(update.value === 'Hello', 'did not arrive');
        assert(update.clientId === 'ana', `the client can impersonate another: ${update.clientId}`);
        assert(update.actorId === 'editor-1', `no actor: ${update.actorId}`);

        await new Promise((r) => setTimeout(r, 200));
        assert(!other.received.some((m) => m.type === 'update'), 'a message crossed documents');
        assert(!ana.received.some((m) => m.type === 'update'), 'it is echoed back to the sender');

        ana.send({ type: 'presence', clients: [] });
        await ana.waitFor((m) => m.type === 'error');

        const late = await connect('docId=home&clientId=late&editor=1');
        const history = await late.waitFor((m) => m.type === 'history');
        assert(history.messages.some((m) => m.value === 'Hello'), 'a latecomer does not receive what came before');
        const presence = await late.waitFor((m) => m.type === 'presence');
        assert(presence.clients.length === 3, `presence: ${JSON.stringify(presence.clients)}`);

        luis.socket.close();
        await ana.waitFor((m) => m.type === 'left' && m.clientId === 'luis');

        for (const client of [ana, other, late]) client.socket.close();
    });

    await check('Durable Object: the room keeps its history across connections', async () => {
        const again = await connect('docId=home&clientId=back&editor=1');
        const history = await again.waitFor((m) => m.type === 'history');
        assert(history.messages.some((m) => m.value === 'Hello'), 'the history does not persist');
        again.socket.close();
    });

    const search = (q, visitor = 'v1') => fetch(`${BASE}/search?q=${encodeURIComponent(q)}`, { headers: { 'x-check-visitor': visitor } });

    await check('visitor mode: composes in the Worker, not indexed, and the D1 cache spends nothing', async () => {
        const first = await search('boots');
        has(await first.text(), 'Composed for the visit');
        assert(first.headers.get('x-robots-tag') === 'noindex', 'it can be indexed');
        assert(first.headers.get('x-check-cached') === 'false', 'the first time should not be cached');

        const second = await search('boots');
        await second.text();
        assert(second.headers.get('x-check-cached') === 'true', 'does not use the D1 cache');
    });

    await check('visitor mode: the limit belongs to the Durable Object, shared, and per visitor', async () => {
        for (const q of ['one', 'two']) await (await search(q, 'v2')).text();
        const limited = await search('three', 'v2');
        await limited.text();
        assert(limited.headers.get('x-check-status') === 'rate_limited', limited.headers.get('x-check-status'));
        const other = await search('four', 'v3');
        await other.text();
        assert(other.headers.get('x-check-status') === 'ok', other.headers.get('x-check-status'));
    });

    await check('Cloudflare Images URLs are generated correctly', async () => {
        const html = await page('/image');
        has(html, '/cdn-cgi/image/width=640,format=auto/media/a.jpg');
        has(html, '1920w');
    });
}

// ============================================
// Run
// ============================================

const workdir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cf-check-')));
const tarballDir = join(workdir, 'tarballs');
mkdirSync(tarballDir);
console.log(`Working directory: ${workdir}`);

let ok = false;
let server;
let log = '';
try {
    const tarballs = Object.fromEntries(PACKAGES.map((dir) => {
        const { name, path } = pack(dir, tarballDir);
        return [name, path];
    }));

    run('npx', ['--yes', '--package', tarballs['create-inti'], 'create-inti', 'site', '--cms', 'local', '--no-install'], workdir);
    const project = join(workdir, 'site');

    const pkgPath = join(project, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    delete pkg.dependencies['@astrojs/node'];
    Object.assign(pkg.dependencies, {
        // Astro 7.4 requires Node 22.23.4: pin 7.3 so it does not depend on the Node version
        '@astrojs/cloudflare': '~14.1.0',
        wrangler: '^4.125.0',
        astro: '~7.3.8',
        '@intijs/core': `file:${tarballs['@intijs/core']}`,
        '@intijs/genui': `file:${tarballs['@intijs/genui']}`,
        '@intijs/cloudflare': `file:${tarballs['@intijs/cloudflare']}`
    });
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    for (const [path, content] of Object.entries(FILES)) {
        const target = join(project, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    }

    run('npm', ['install', '--no-audit', '--no-fund'], project);
    run('npx', ['astro', 'build'], project);
    console.log('✓ the project builds for Cloudflare');

    server = spawn('npx', ['astro', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
        cwd: project,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
        shell: win,
        detached: !win
    });
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));

    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
        up = await fetch(`${BASE}/`).then((r) => r.status < 500).catch(() => false);
        if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!up) throw new Error(`workerd did not respond\n${log.slice(-1500)}`);

    await checks();

    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks in workerd`);
    if (failed.length > 0) console.log(log.slice(-1200));
    ok = failed.length === 0;
    if (!ok) process.exitCode = 1;
} catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
} finally {
    if (server) {
        try {
            if (win) execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
            else process.kill(-server.pid, 'SIGTERM');
        } catch {
            // it had already exited
        }
    }
    if (keep || !ok) console.log(`Project kept at ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true, maxRetries: 3 });
}
