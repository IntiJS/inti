#!/usr/bin/env node
/**
 * Checks generation and personalization in a real project, with the packages as
 * they would be published: create-inti generates it, it is built and used over HTTP
 * in production and in development.
 *
 * The model is fake on purpose: what is tested is everything around it
 * (routes, permissions, validation, rendering, cookies, headers), and that none of it
 * depends on a model existing. The real API call is not covered here.
 *
 * Usage: node scripts/genui-check.mjs [5|6|7] [--keep]   Requires `npm run build`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const major = process.argv.slice(2).find((arg) => /^[567]$/.test(arg)) ?? '7';
const win = process.platform === 'win32';

/** The node adapter has its own major */
const VERSIONS = {
    5: { astro: '^5.0.0', node: '^9.0.0' },
    6: { astro: '^6.0.0', node: '^10.0.0' },
    7: { astro: '^7.0.0', node: '^11.0.0' }
}[major];

const PACKAGES = ['packages/core', 'packages/genui', 'packages/create-inti'];

const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const EDITOR = { 'x-check-editor': '1' };


function run(command, args, cwd) {
    execFileSync(command, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'], shell: win });
}

function pack(dir, destination) {
    const output = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
        cwd: join(ROOT, dir),
        encoding: 'utf8',
        shell: win
    });
    // `prepare` may write earlier to the same output
    const json = JSON.parse(output.slice(output.search(/^\[\s*$/m)));
    return { name: json[0].name, path: join(destination, json[0].filename) };
}

function serve(command, args, cwd, env) {
    let log = '';
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: win, detached: !win });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    return {
        log: () => log,
        stop() {
            try {
                if (win) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                else process.kill(-child.pid, 'SIGTERM');
            } catch {
                // it had already exited
            }
        }
    };
}

async function waitFor(url, server) {
    for (let i = 0; i < 90; i++) {
        try {
            if ((await fetch(url)).status < 500) return;
        } catch {
            // starting
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${url} did not respond\n${server.log().slice(-1500)}`);
}

// ============================================
// Project
// ============================================

const CONTENT = {
    documents: {
        home: {
            id: 'home',
            slug: 'home',
            title: 'Home',
            seo: { title: 'Home', description: 'Check page' },
            blocks: [
                { type: 'Hero', data: { heading: 'Default headline', inti_slot: 'hero' } },
                { type: 'Hero', data: { heading: 'Mobile headline', inti_slot: 'hero', inti_audience: 'device:mobile' } },
                { type: 'Hero', data: { heading: 'Vegan headline', inti_slot: 'hero', inti_audience: 'pref.diet:vegan' } },
                { type: 'Hero', data: { heading: 'For those viewing boots', inti_slot: 'hero', inti_audience: 'seen.boots:2' } },
                { type: 'Text', data: { body: 'Always visible text' } }
            ]
        }
    }
};

const PAGE = `---
import Layout from '../layouts/Layout.astro';
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import WhyThis from '@intijs/core/astro/WhyThis.astro';
import PreferencesForm from '@intijs/core/astro/PreferencesForm.astro';
import VisualBridgeAuto from '@intijs/core/visual-bridge/VisualBridgeAuto.astro';
import { adaptPage, env, readDraftPage } from '@intijs/core/server';
import { readPage } from '../lib/cms';

registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const slug = Astro.params.slug ?? 'home';

let page;
try {
    page = (await readDraftPage(slug, Astro)) ?? (await readPage(slug));
} catch {
    return new Response('Page not found', { status: 404 });
}

const { blocks, decisions } = await adaptPage(page.blocks, Astro, { track: Astro.url.searchParams.get('category') ?? undefined });
---

<Layout page={page}>
    <p data-check-env>{env('INTI_CHECK_ENV')}</p>
    <BlockRenderer blocks={blocks} page={page} />
    <WhyThis decisions={decisions} settingsUrl="/" />
    <PreferencesForm consent options={{ diet: { label: 'Diet', values: ['vegan', 'omnivore'] } }} />
</Layout>
<VisualBridgeAuto enabled={true} blockTypes={[{ nativeType: 'Hero', label: 'Hero', fields: { heading: { type: 'string' } } }]} />
`;

const MIDDLEWARE = `import { registerIntiPlugin } from '@intijs/core/plugins';
import { createBlockGenerator } from '@intijs/genui';
import { fakeModel } from './lib/fake-model';

registerIntiPlugin({
    name: 'check',
    resolveActor: (ctx) => (ctx.request?.headers.get('x-check-editor') === '1' ? { id: 'e', role: 'editor' } : null),
    beforeWrite: (ctx) => ({ allowed: Boolean(ctx.actor) }),
    getBlockGenerator: () => (import.meta.env.INTI_CHECK_NO_AI === '1' || process.env.INTI_CHECK_NO_AI === '1' ? null : createBlockGenerator({ provider: fakeModel }))
});

export const onRequest = (_ctx, next) => next();
`;

const FAKE_MODEL = `/** Answers the way a model would, including with what must not be accepted */
export const fakeModel = {
    calls: 0,
    async generate(request) {
        this.calls++;
        return JSON.parse(this.answer(request));
    },
    async *stream(request) {
        this.calls++;
        const json = this.answer(request);
        for (let i = 0; i < json.length; i += 11) yield json.slice(i, i + 11);
    },
    answer(request) {
        if (request.prompt.includes('products')) {
            return JSON.stringify({ blocks: [
                { nativeType: 'ProductGrid', data: { heading: 'Boots', products: ['p2', 'made-up'] } },
                { nativeType: 'MadeUp', data: {} }
            ] });
        }
        return JSON.stringify({ blocks: [
            { nativeType: 'Hero', data: { heading: 'Generated by the test', css: 'color:red' } },
            { nativeType: 'Hero', data: { heading: 'javascript:alert(1)' } },
            { nativeType: 'MadeUp', data: {} }
        ] });
    }
};
`;

const PRODUCT_GRID = `---
const { heading, products = [] } = Astro.props;
---
<section>
    <h2 data-inti-field="heading">{heading}</h2>
    <ul>{products.map((product) => <li>{product.name}: {product.price} €</li>)}</ul>
</section>
`;

const SEARCH = `---
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import { createVisitorComposer, defineVocabulary, fromData, VISITOR_HEADERS } from '@intijs/genui';
import { fakeModel } from '../lib/fake-model';

export const partial = true;

registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const composer = (globalThis.__checkComposer ??= createVisitorComposer({
    provider: fakeModel,
    limits: { perMinute: 3, maxPromptLength: 50 },
    vocabulary: defineVocabulary({
        ProductGrid: { fields: { heading: { type: 'string' }, products: fromData('products', { max: 4 }) } }
    }),
    sources: {
        products: [
            { id: 'p1', summary: 'Sneaker', value: { name: 'Sneaker', price: 59 } },
            { id: 'p2', summary: 'Boot', value: { name: 'Boot', price: 120 } }
        ]
    }
}));

const result = await composer.compose(Astro.url.searchParams.get('q') ?? '', { visitorKey: Astro.request.headers.get('x-check-visitor') ?? 'anon' });

for (const [name, value] of Object.entries(VISITOR_HEADERS)) Astro.response.headers.set(name, value);
Astro.response.headers.set('X-Check-Status', result.status);

const blocks = result.blocks.map((block) => ({ type: block.nativeType, data: block.data }));
---
<BlockRenderer blocks={blocks} editable={false} audit={false} />
`;

/**
 * Blocks generated in streaming with what Astro already ships: an async iterable in
 * the template. The HTML goes out as the model finishes each block, with no
 * client-side JavaScript.
 */
const STREAM_PAGE = `---
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import { composeStream, defineVocabulary } from '@intijs/genui';

registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const provider = {
    async generate() {
        return { blocks: [] };
    },
    async *stream() {
        yield '{"blocks":[';
        for (const n of [1, 2, 3]) {
            yield (n > 1 ? ',' : '') + JSON.stringify({ nativeType: 'Hero', data: { heading: 'Block ' + n } });
            await sleep(500);
        }
        yield ']}';
    }
};

const events = composeStream({
    prompt: 'x',
    provider,
    vocabulary: defineVocabulary({ Hero: { fields: { heading: { type: 'string' } } } })
});
---
<html lang="en">
    <head><title>Streaming</title></head>
    <body>
        <h1>Page header</h1>
        {(async function* () {
            for await (const event of events) {
                if (event.type !== 'block') continue;
                yield <BlockRenderer blocks={[{ type: event.rendered.nativeType, data: event.rendered.data }]} editable={false} audit={false} />;
            }
        })()}
        <footer>The end</footer>
    </body>
</html>
`;

/** A slow zone isolated from the rest of the page */
const SLOW_ISLAND = `---
await new Promise((resolve) => setTimeout(resolve, 1000));
const visitor = Astro.cookies.get('who')?.value ?? 'anonymous';
---
<p>Island ready for {visitor}</p>
`;

const BROKEN_ISLAND = `---
throw new Error('island failure');
---
<p>Never shown</p>
`;

const ISLAND_PAGE = `---
import SlowIsland from '../components/SlowIsland.astro';
import BrokenIsland from '../components/BrokenIsland.astro';
---
<html lang="en">
    <head><title>Islands</title></head>
    <body>
        <SlowIsland server:defer><p slot="fallback">Loading zone</p></SlowIsland>
        <BrokenIsland server:defer><p slot="fallback">Fallback for the broken one</p></BrokenIsland>
        <p>Rest of the page</p>
    </body>
</html>
`;

function prepare(project, tarballs) {
    const pkgPath = join(project, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.dependencies.astro = VERSIONS.astro;
    pkg.dependencies['@astrojs/node'] = VERSIONS.node;
    pkg.dependencies['@intijs/core'] = `file:${tarballs['@intijs/core']}`;
    pkg.dependencies['@intijs/genui'] = `file:${tarballs['@intijs/genui']}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    writeFileSync(join(project, '.inti/content.json'), JSON.stringify(CONTENT, null, 2));
    writeFileSync(join(project, 'src/pages/[...slug].astro'), PAGE);
    writeFileSync(join(project, 'src/pages/search.astro'), SEARCH);
    writeFileSync(join(project, '.env'), 'INTI_CHECK_ENV=from-dot-env\n');
    writeFileSync(join(project, 'src/middleware.ts'), MIDDLEWARE);
    writeFileSync(join(project, 'src/lib/fake-model.js'), FAKE_MODEL);
    writeFileSync(join(project, 'src/blocks/ProductGrid.astro'), PRODUCT_GRID);
    writeFileSync(join(project, 'src/pages/stream.astro'), STREAM_PAGE);
    writeFileSync(join(project, 'src/pages/islands.astro'), ISLAND_PAGE);
    mkdirSync(join(project, 'src/components'), { recursive: true });
    writeFileSync(join(project, 'src/components/SlowIsland.astro'), SLOW_ISLAND);
    writeFileSync(join(project, 'src/components/BrokenIsland.astro'), BROKEN_ISLAND);
}

// ============================================
// Checks
// ============================================

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

const has = (html, text) => assert(html.includes(text), `missing "${text}" in:\n${html.slice(0, 600)}`);
const hasNot = (html, text) => assert(!html.includes(text), `unexpected "${text}"`);

/** A response's cookies, ready to send with the next one */
const cookiesOf = (response) =>
    response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; ');

async function production(project, base) {
    // Astro compares a form's Origin with the host it announces itself, which
    // depending on the version is not the connection's. A browser would send that same one
    const canonical = /rel="canonical" href="([^"]+)"/.exec(await (await fetch(`${base}/`)).text())?.[1];
    const origin = new URL(canonical ?? base).origin;

    const get = (path = '/', headers = {}) => fetch(base + path, { headers: { 'user-agent': DESKTOP, ...headers }, redirect: 'manual' });
    const page = async (path, headers) => (await get(path, headers)).text();
    const action = (name, body, headers = EDITOR) =>
        fetch(`${base}/_actions/inti.${name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body)
        });
    const stored = () => JSON.parse(readFileSync(join(project, '.inti/content.json'), 'utf8')).documents;

    // Personalization
    await check('no matches: default content, no JavaScript and no cookies', async () => {
        const response = await get();
        const html = await response.text();
        has(html, 'Default headline');
        has(html, 'Always visible text');
        hasNot(html, 'Mobile headline');
        hasNot(html, 'Vegan headline');
        assert(!/<script[^>]*type="module"/.test(html), 'the visitor receives JavaScript');
        hasNot(html, 'data-inti-inline-editor');
        hasNot(html, 'inti_audience');
        hasNot(html, 'data-inti-why');
        assert(response.headers.getSetCookie().length === 0, 'receives cookies for no reason');
    });

    await check('the adapted response cannot be stored in a shared cache', async () => {
        const response = await get();
        assert(response.headers.get('cache-control')?.includes('private'), 'missing Cache-Control: private');
        assert(/cookie/i.test(response.headers.get('vary') ?? ''), 'missing Vary: Cookie');
    });

    await check('a phone gets its version, and is told why', async () => {
        const html = await page('/', { 'user-agent': MOBILE });
        has(html, 'Mobile headline');
        hasNot(html, 'Default headline');
        has(html, 'data-inti-why');
        has(html, 'your device');
    });

    await check('a search engine always gets the default content', async () => {
        const html = await page('/', { 'user-agent': `${GOOGLEBOT} Mobile iPhone` });
        has(html, 'Default headline');
        hasNot(html, 'Mobile headline');
    });

    await check('within the session the version does not change', async () => {
        const first = await get('/', { 'user-agent': MOBILE });
        await first.text();
        const cookie = cookiesOf(first);
        assert(cookie.includes('inti_dec'), 'does not store the decision');
        const html = await page('/', { 'user-agent': DESKTOP, cookie });
        has(html, 'Mobile headline');
    });

    await check('a preference chosen in the form is applied, without JavaScript', async () => {
        const body = new URLSearchParams({ 'pref.diet': 'vegan', next: '/' });
        const saved = await fetch(`${base}/api/inti/preferences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin },
            body,
            redirect: 'manual'
        });
        assert(saved.status === 303, `responds ${saved.status}`);
        assert(saved.headers.get('location') === '/', `redirects to ${saved.headers.get('location')}`);
        const cookie = cookiesOf(saved);
        has(await page('/', { cookie }), 'Vegan headline');
        has(await page('/', { cookie }), 'your diet preference');
    });

    await check('preferences do not redirect off the site', async () => {
        for (const next of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
            const saved = await fetch(`${base}/api/inti/preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin },
                body: new URLSearchParams({ next }),
                redirect: 'manual'
            });
            assert(saved.headers.get('location') === '/', `${next} redirects to ${saved.headers.get('location')}`);
        }
    });

    await check('what was viewed only counts with consent, and withdrawing it deletes it', async () => {
        const without = await get('/?category=boots');
        await without.text();
        assert(!cookiesOf(without).includes('inti_seen'), 'observes without consent');
        assert(!cookiesOf(without).includes('inti_vid'), 'identifies without consent');

        const consent = await fetch(`${base}/api/inti/preferences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin },
            body: new URLSearchParams({ consent: '1', next: '/' }),
            redirect: 'manual'
        });
        let jar = cookiesOf(consent);

        for (let i = 0; i < 2; i++) {
            const response = await get('/?category=boots', { cookie: jar });
            await response.text();
            const updates = cookiesOf(response);
            const merged = new Map([...jar.split('; '), ...updates.split('; ')].filter(Boolean).map((c) => [c.split('=')[0], c]));
            jar = [...merged.values()].join('; ');
        }
        assert(jar.includes('inti_vid'), 'with consent it does not assign an identifier');
        has(await page('/', { cookie: jar }), 'For those viewing boots');

        const withdrawn = await fetch(`${base}/api/inti/preferences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin, cookie: jar },
            body: new URLSearchParams({ next: '/' }),
            redirect: 'manual'
        });
        const cleared = withdrawn.headers.getSetCookie().join('\n');
        assert(/inti_seen=;|inti_seen=deleted/.test(cleared), 'does not delete what was observed');
        assert(/inti_vid=;|inti_vid=deleted/.test(cleared), 'does not delete the identifier');
    });

    await check('"view as" does not work for a visitor, and does for an editor', async () => {
        hasNot(await page('/?inti-as=device:mobile'), 'Mobile headline');
        const html = await page('/?inti-as=device:mobile', EDITOR);
        has(html, 'Mobile headline');
        hasNot(html, 'Default headline');
    });

    await check('the editor sees every version with its address intact', async () => {
        const html = await page('/', EDITOR);
        for (const text of ['Default headline', 'Mobile headline', 'Vegan headline']) has(html, text);
        has(html, 'data-inti-inline-editor');
        has(html, 'device:mobile');
        const indexes = [...html.matchAll(/data-inti-block-index="(\d+)"/g)].map((match) => match[1]);
        assert(indexes.join() === '0,1,2,3,4', `indexes: ${indexes}`);
    });

    await check('editing a variant writes to that variant', async () => {
        const response = await action('updateBlockField', { documentId: 'home', blockIndex: 1, field: 'heading', value: 'Mobile edited' });
        assert(response.ok, `responds ${response.status}`);
        assert(stored().home.blocks[1].data.heading === 'Mobile edited', 'wrote to another block');
        assert(stored().home.blocks[0].data.heading === 'Default headline', 'touched another block');
        has(await page('/', { 'user-agent': MOBILE }), 'Mobile edited');
    });

    // Proposals
    const generate = (headers = EDITOR, body = { prompt: 'A section', blockTypes: [{ nativeType: 'Hero', fields: { heading: { type: 'string' } } }] }) =>
        fetch(`${base}/api/inti/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body)
        });

    await check('generating requires an editor session', async () => {
        assert((await generate({})).status === 401, 'an anonymous user can generate');
    });

    await check('the proposal arrives block by block, validated, and writes nothing', async () => {
        const before = JSON.stringify(stored());
        const response = await generate();
        assert(response.headers.get('content-type')?.includes('ndjson'), 'not a stream');
        const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

        const blocks = events.filter((event) => event.type === 'block');
        assert(blocks.length === 2, `${blocks.length} blocks`);
        assert(blocks[0].block.data.heading === 'Generated by the test', 'content');
        assert(blocks[0].block.data.css === undefined, 'accepts an undeclared field');
        assert(blocks[1].block.data.heading === undefined, 'accepts javascript:');
        assert(events.some((event) => event.type === 'warning' && event.message.includes('MadeUp')), 'does not warn about the made-up type');
        assert(JSON.stringify(stored()) === before, 'generating wrote to the CMS');
    });

    await check('the preview uses the real component, only for editors, and does not write', async () => {
        const before = JSON.stringify(stored());
        const body = JSON.stringify({ blocks: [{ nativeType: 'Hero', data: { heading: 'Preview <b>test</b>' } }] });
        const preview = (headers) =>
            fetch(`${base}/api/inti/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

        assert((await preview({})).status === 401, 'an anonymous user can render');

        const response = await preview(EDITOR);
        assert(response.ok, `responds ${response.status}`);
        assert(response.headers.get('x-robots-tag') === 'noindex', 'it can be indexed');
        const html = await response.text();
        has(html, 'data-inti-block="Hero"');
        has(html, 'Preview &lt;b&gt;test&lt;/b&gt;');
        hasNot(html, '<html');
        assert(JSON.stringify(stored()) === before, 'the preview wrote');
    });

    await check('accepting the proposal does insert it, through the permissioned path', async () => {
        const blocks = [{ nativeType: 'Hero', data: { heading: 'Accepted' } }];
        assert((await action('insertBlocks', { documentId: 'home', index: 5, blocks }, {})).status === 403, 'an anonymous user can insert');
        const response = await action('insertBlocks', { documentId: 'home', index: 5, blocks });
        assert(response.ok, `responds ${response.status}`);
        assert(stored().home.blocks[5].data.heading === 'Accepted', 'it was not inserted');
        await action('removeBlock', { documentId: 'home', index: 5 });
    });

    // Drafts
    await check('a draft is not visible until published, not even with the parameter', async () => {
        assert((await action('createDraft', { documentId: 'home' }, {})).status === 403, 'an anonymous user can create drafts');

        const created = await action('createDraft', { documentId: 'home' });
        assert(created.ok, `creating the draft responds ${created.status}`);
        const edit = await action('updateBlockField', { documentId: 'home--draft', blockIndex: 4, field: 'body', value: 'Draft text' });
        assert(edit.ok, `editing the draft responds ${edit.status}`);

        hasNot(await page('/'), 'Draft text');
        hasNot(await page('/?inti-draft=1'), 'Draft text');

        const asEditor = await get('/?inti-draft=1', EDITOR);
        has(await asEditor.text(), 'Draft text');
        assert(asEditor.headers.get('cache-control') === 'private, no-store', 'the draft can be cached');
        assert(asEditor.headers.get('x-robots-tag') === 'noindex', 'the draft can be indexed');

        const publish = await action('publishDraft', { documentId: 'home--draft' });
        assert(publish.ok, `publishing responds ${publish.status}`);
        has(await page('/'), 'Draft text');
        assert(stored()['home--draft'] === undefined, 'the copy is still there');
    });

    // Visitor mode
    const search = (q, visitor = 'v1') => get(`/search?q=${encodeURIComponent(q)}`, { 'x-check-visitor': visitor });

    await check('visitor mode: the price comes from the server and anything made up is discarded', async () => {
        const response = await search('boots');
        const html = await response.text();
        assert(response.headers.get('x-check-status') === 'ok', response.headers.get('x-check-status'));
        has(html, 'Boot: 120 €');
        hasNot(html, 'made-up');
        hasNot(html, 'MadeUp');
    });

    await check('visitor mode: not indexed, not cached in shared caches and adds no JavaScript', async () => {
        const response = await search('boots');
        assert(response.headers.get('x-robots-tag') === 'noindex', 'it can be indexed');
        assert(response.headers.get('cache-control') === 'private, no-store', 'shared cache');
        const html = await response.text();
        assert(!html.includes('<script'), 'adds JavaScript');
        hasNot(html, '<html');
    });

    await check('visitor mode: the per-visitor limit and an invalid request do not break', async () => {
        await search('one', 'v2');
        await search('two', 'v2');
        await search('three', 'v2');
        const limited = await search('four', 'v2');
        assert(limited.status === 200, `responds ${limited.status}`);
        assert(limited.headers.get('x-check-status') === 'rate_limited', limited.headers.get('x-check-status'));
        assert((await search('x'.repeat(60), 'v3')).headers.get('x-check-status') === 'invalid_prompt', 'accepts a long request');
    });
}

async function streamingAndIslands(base) {
    await check('generated blocks reach the browser as they finish, without JavaScript', async () => {
        const started = Date.now();
        const response = await fetch(`${base}/stream`);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

        let html = '';
        const seen = {};
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            html += value;
            for (const mark of ['Page header', 'Block 1', 'Block 2', 'Block 3', 'The end']) {
                if (html.includes(mark) && seen[mark] === undefined) seen[mark] = Date.now() - started;
            }
        }

        console.log(`    (ms since the request: ${JSON.stringify(seen)})`);
        assert(seen['Block 1'] !== undefined && seen['The end'] !== undefined, 'marks missing');
        assert(seen['The end'] - seen['Block 1'] >= 800, 'the HTML arrives all at once at the end');
        assert(seen['Block 2'] - seen['Block 1'] >= 300, 'two blocks arrive together');
        assert(!html.includes('<script'), 'adds JavaScript');
    });

    await check('a slow zone in a Server Island does not delay the page, and a failure does not break it', async () => {
        const started = Date.now();
        const response = await fetch(`${base}/islands`);
        const html = await response.text();
        const elapsed = Date.now() - started;
        console.log(`    (page in ${elapsed} ms; the island takes 1000 ms)`);

        assert(elapsed < 800, `the page takes ${elapsed} ms`);
        has(html, 'Loading zone');
        has(html, 'Rest of the page');
        hasNot(html, 'Island ready');

        // Each island names its URL more than once in its script
        const scripts = [...new Set([...html.matchAll(/\/_server-islands\/[^'"\`\s]+/g)].map((match) => match[0].replace(/&amp;/g, '&')))];
        assert(scripts.length === 2, `${scripts.length} islands: ${scripts.join(' ')}`);

        const slow = scripts.find((url) => url.includes('SlowIsland'));
        const island = await fetch(base + slow.replace(/&amp;/g, '&'), { headers: { cookie: 'who=ana' } });
        const text = await island.text();
        assert(text.includes('Island ready for ana'), `the island responds ${island.status}: ${text.slice(0, 200)}`);

        const broken = scripts.find((url) => url.includes('BrokenIsland'));
        const failed = await fetch(base + broken.replace(/&amp;/g, '&'));
        await failed.text();
        console.log(`    (the broken island responds ${failed.status})`);
    });
}

async function withoutAi(base) {
    await check('in production the variable received at startup wins', async () => {
        has(await (await fetch(`${base}/`)).text(), 'from-startup');
    });

    await check('with no model configured everything keeps working', async () => {
        const home = await fetch(`${base}/`, { headers: { 'user-agent': MOBILE } });
        assert(home.status === 200, `the page responds ${home.status}`);
        has(await home.text(), 'data-inti-why');

        const response = await fetch(`${base}/api/inti/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...EDITOR },
            body: JSON.stringify({ prompt: 'x', blockTypes: [{ nativeType: 'Hero' }] })
        });
        assert(response.status === 501, `generating responds ${response.status}`);
    });
}

async function development(base) {
    await check('in development the .env variables are read', async () => {
        const html = await (await fetch(`${base}/`)).text();
        has(html, 'from-dot-env');
    });

    await check('in development the adapted page loads with the editor and the routes respond', async () => {
        const html = await (await fetch(`${base}/`, { headers: { 'user-agent': DESKTOP } })).text();
        has(html, 'data-inti-inline-editor');
        has(html, 'data-inti-adaptive');
        has(html, 'data-drafts="true"');
        has(html, 'Mobile edited');

        const preview = await fetch(`${base}/api/inti/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blocks: [{ nativeType: 'Hero', data: { heading: 'Dev' } }] })
        });
        has(await preview.text(), 'Dev');
    });
}

// ============================================
// Run
// ============================================

const workdir = realpathSync.native(mkdtempSync(join(tmpdir(), 'genui-check-')));
const tarballDir = join(workdir, 'tarballs');
mkdirSync(tarballDir);
console.log(`Astro ${major}. Working directory: ${workdir}`);

let ok = false;
let servers = [];
try {
    const tarballs = Object.fromEntries(PACKAGES.map((dir) => {
        const { name, path } = pack(dir, tarballDir);
        return [name, path];
    }));

    run('npx', ['--yes', '--package', tarballs['create-inti'], 'create-inti', 'site', '--cms', 'local', '--no-install'], workdir);
    const project = join(workdir, 'site');
    prepare(project, tarballs);

    run('npm', ['install', '--no-audit', '--no-fund'], project);
    run('npx', ['astro', 'build'], project);
    console.log('✓ the project builds');

    const prod = serve('node', ['./dist/server/entry.mjs'], project, { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '43411' });
    servers.push(prod);
    await waitFor('http://127.0.0.1:43411/', prod);
    await production(project, 'http://127.0.0.1:43411');
    await streamingAndIslands('http://127.0.0.1:43411');
    prod.stop();

    const noAi = serve('node', ['./dist/server/entry.mjs'], project, { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '43412', INTI_CHECK_NO_AI: '1', INTI_CHECK_ENV: 'from-startup' });
    servers.push(noAi);
    await waitFor('http://127.0.0.1:43412/', noAi);
    await withoutAi('http://127.0.0.1:43412');
    noAi.stop();

    const dev = serve('npx', ['astro', 'dev', '--port', '43413', '--host', '127.0.0.1'], project, {});
    servers.push(dev);
    await waitFor('http://127.0.0.1:43413/', dev);
    await development('http://127.0.0.1:43413');
    dev.stop();

    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks (Astro ${major})`);
    ok = failed.length === 0;
    if (!ok) process.exitCode = 1;
} catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
} finally {
    for (const server of servers) server.stop();
    if (keep || !ok) console.log(`Project kept at ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
}
