#!/usr/bin/env node
/**
 * Checks that an Inti site builds for Vercel and works inside the function Vercel deploys.
 *
 * What breaks on Vercel and nowhere else is file tracing: a function ships only the files
 * Vercel's tracer saw it import, not the project's `node_modules`. A font read with a
 * computed path, a native binary loaded with `import()`, a file the code writes next to
 * itself: all fine in `astro dev` and in Node, missing or read-only on Vercel.
 *
 * So the function is not run from the project. Its folder (`.vercel/output/functions/
 * _render.func`, exactly what Vercel uploads) is copied to a directory with no
 * `node_modules` above it, its handler is imported from there, and requests are sent to it:
 * any file it needs and did not ship fails here as it would in production.
 *
 * Covered: the documented setup, Inti's actions and search routes, the Kitsuden
 * middleware, and @intijs/infographic on the page and as a PNG (native rasterizer and
 * the embedded Inter font: the native binary has to be traced, and no network is used).
 *
 * Not covered: Vercel's edge runtime, its CDN, and anything that needs an account.
 *
 * Usage: node scripts/vercel-check.mjs <5|6|7> [--keep]   Requires `npm run build`.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');

/** @astrojs/vercel goes by its own major, and each pins Astro's */
const VERCEL_ADAPTER_BY_ASTRO_MAJOR = { 5: '^8', 6: '^10', 7: '^11' };
const major = process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) ?? '7';
if (!VERCEL_ADAPTER_BY_ASTRO_MAJOR[major]) {
    console.error(`Usage: node scripts/vercel-check.mjs <${Object.keys(VERCEL_ADAPTER_BY_ASTRO_MAJOR).join('|')}> [--keep]`);
    process.exit(2);
}
const win = process.platform === 'win32';

const PACKAGES = ['packages/core', 'packages/adapter-kitsuden', 'packages/infographic'];

function pack(dir, destination) {
    const output = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], { cwd: join(ROOT, dir), encoding: 'utf8', shell: win });
    const json = JSON.parse(output.slice(output.search(/^\[\s*$/m)));
    return { name: json[0].name, path: join(destination, json[0].filename) };
}

function run(command, args, cwd, label) {
    process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
    try {
        execFileSync(command, args, { cwd, stdio: 'inherit', shell: win });
    } catch {
        console.error(`\n✗ Vercel: ${label} failed`);
        process.exit(1);
    }
}

const INFOGRAPHIC = `{
    title: 'Sales by channel',
    source: 'CRM',
    sections: [
        { kind: 'kpis', items: [{ label: 'Revenue', value: 1284500, format: 'currency', currency: 'EUR', delta: 12.5 }] },
        { kind: 'bar', title: 'Channels', items: [{ label: 'Web', value: 120 }, { label: 'Store', value: 80 }] }
    ]
}`;

const FIXTURE = {
    'package.json': (tarballs) =>
        JSON.stringify(
            {
                name: 'inti-vercel-check',
                private: true,
                type: 'module',
                dependencies: {
                    astro: `^${major}`,
                    '@astrojs/vercel': VERCEL_ADAPTER_BY_ASTRO_MAJOR[major],
                    '@resvg/resvg-js': '^2.6.0',
                    ...Object.fromEntries(tarballs.map(({ name, path }) => [name, `file:${path}`]))
                }
            },
            null,
            2
        ),

    'astro.config.mjs': () => `import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import inti from '@intijs/core';
import { stripSecretsForBuild } from '@intijs/adapter-kitsuden/astro';

stripSecretsForBuild();

export default defineConfig({
    output: 'server',
    adapter: vercel(),
    integrations: [inti()]
});
`,

    'src/actions/index.ts': () => `import { intiActions } from '@intijs/core/actions';
export const server = { inti: intiActions };
`,

    // The Kitsuden middleware: it registers the editor plugin, so writes are guarded
    'src/middleware.ts': () => `import { kitsudenMiddleware, createPageCache } from '@intijs/adapter-kitsuden/astro';

export const cache = createPageCache({ ttlSeconds: 30 });
export const onRequest = kitsudenMiddleware({ api: process.env.KITSUDEN_API_URL ?? 'https://cms.invalid', cache });
`,

    'src/blocks/HeroBanner.astro': () => `---
const { heading } = Astro.props;
---
<section><h1 data-inti-field="heading">{heading}</h1></section>
`,

    'src/blocks/infographic.astro': () => `---
import Infographic from '@intijs/infographic/Infographic.astro';
---
<Infographic data={Astro.props} format="blog" />
`,

    'src/pages/[...slug].astro': () => `---
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import VisualBridgeAuto from '@intijs/core/visual-bridge/VisualBridgeAuto.astro';
import IntiSeo from '@intijs/core/astro/IntiSeo.astro';

registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const page = {
    id: '1',
    slug: 'home',
    title: 'Vercel',
    blocks: [
        { type: 'HeroBanner', data: { heading: 'Hello from Vercel' } },
        { type: 'infographic', data: ${INFOGRAPHIC} },
        { type: 'HeroBanner', data: { heading: 'HIDDEN PROMO' }, meta: { visible: false } }
    ],
    seo: { title: 'Vercel', description: 'Vercel check' }
};
---
<html lang="en">
<head><IntiSeo page={page} url={Astro.url.href} siteName="Check" /></head>
<body>
    <BlockRenderer blocks={page.blocks} page={page} />
    <VisualBridgeAuto />
</body>
</html>
`,

    // An image rendered inside the function: the native rasterizer and the fonts must ship with it
    'src/pages/infographic.png.ts': () => `import { renderInfographic } from '@intijs/infographic';

export const prerender = false;

export async function GET() {
    const { slides } = await renderInfographic(${INFOGRAPHIC}, { format: 'og' });
    return new Response(slides[0].bytes, { headers: { 'content-type': slides[0].contentType } });
}
`,

    'src/pages/api/kitsuden/purge.ts': () => `import { purgeRoute } from '@intijs/adapter-kitsuden/astro';
import { cache } from '../../../middleware';

export const prerender = false;
export const POST = purgeRoute(cache, () => process.env.KITSUDEN_PURGE_SECRET);
`
};

function size(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return bytes[0] === 0x89 && bytes[1] === 0x50 ? { type: 'png', width: view.getUint32(16), height: view.getUint32(20) } : { type: 'unknown' };
}

function folderSize(dir) {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        total += entry.isDirectory() ? folderSize(path) : statSync(path).size;
    }
    return total;
}

/**
 * A function to send Requests to the deployed handler. @astrojs/vercel 10+ exports
 * `{ fetch(request) }`; version 8 (Astro 5) a Node `(req, res)` handler, which is served here
 * from a local HTTP server, the way Vercel's Node launcher calls it.
 */
async function invoker(handler) {
    if (typeof handler?.fetch === 'function') return (path, init) => handler.fetch(new Request(`https://check.vercel.app${path}`, init));
    if (typeof handler !== 'function') throw new Error(`unknown handler shape: ${typeof handler}`);
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
        req.headers.host = 'check.vercel.app';
        req.headers['x-forwarded-proto'] = 'https';
        Promise.resolve(handler(req, res)).catch((error) => {
            res.statusCode = 500;
            res.end(String(error?.stack ?? error));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    server.unref();
    const { port } = server.address();
    // Captured now: the render check cuts the global fetch to prove the function needs no network
    const realFetch = globalThis.fetch;
    return (path, init) => realFetch(`http://127.0.0.1:${port}${path}`, { ...init, redirect: 'manual' });
}

async function checkFunction(project) {
    const output = join(project, '.vercel/output');
    const failures = [];

    if (!existsSync(join(output, 'config.json'))) failures.push('no .vercel/output/config.json');
    const source = join(output, 'functions/_render.func');
    const config = JSON.parse(readFileSync(join(source, '.vc-config.json'), 'utf8'));
    if (!/^nodejs\d+\.x$/.test(config.runtime)) failures.push(`unexpected runtime ${config.runtime}`);

    // What Vercel uploads, somewhere with no node_modules above it
    const isolated = realpathSync.native(mkdtempSync(join(tmpdir(), 'inti-vercel-fn-')));
    cpSync(source, isolated, { recursive: true });

    // The native rasterizer is reached through a dynamic import: it has to be traced
    const resvg = join(isolated, 'node_modules/@resvg');
    if (!existsSync(resvg) || !readdirSync(resvg).some((name) => name.startsWith('resvg-js-'))) {
        failures.push('the native resvg binary was not traced into the function');
    }
    console.log(`\nFunction: ${(folderSize(isolated) / 1024 / 1024).toFixed(1)} MB, handler ${config.handler}`);

    const previous = process.cwd();
    process.chdir(isolated);
    process.env.NODE_ENV = 'production';
    process.env.KITSUDEN_PURGE_SECRET = 'check-only';
    try {
        const handler = (await import(pathToFileURL(join(isolated, config.handler)).href)).default;
        const call = await invoker(handler);

        const page = await call('/');
        const html = await page.text();
        if (page.status !== 200) failures.push(`the page responds ${page.status}: ${html.slice(0, 300)}`);
        if (!html.includes('Hello from Vercel')) failures.push('the page does not render its blocks');
        if (!html.includes('inti-infographic')) failures.push('the infographic block does not render');
        if (/<script[^>]*type="module"/.test(html)) failures.push('the visitor receives JavaScript');
        if (html.includes('data-inti-block-json') || html.includes('data-inti-inline-editor')) failures.push('the editor reaches an anonymous visitor');
        if (html.includes('HIDDEN PROMO')) failures.push('a hidden block reaches the HTML');
        if (page.headers.get('x-inti-cache') !== 'MISS') failures.push(`the page cache did not store the page (x-inti-cache: ${page.headers.get('x-inti-cache')})`);
        if ((await call('/')).headers.get('x-inti-cache') !== 'HIT') failures.push('the second visit is not served from the page cache');

        // Rendered with the network cut: the font has to come with the function, not from Google
        const realFetch = globalThis.fetch;
        let fetched = 0;
        globalThis.fetch = async (...args) => {
            fetched++;
            throw new Error(`network used during the render: ${String(args[0])}`);
        };
        let image;
        try {
            image = await call('/infographic.png');
        } finally {
            globalThis.fetch = realFetch;
        }
        if (fetched > 0) failures.push(`the infographic render reached the network ${fetched} time(s)`);
        const bytes = new Uint8Array(await image.arrayBuffer());
        const got = size(bytes);
        if (image.status !== 200 || got.type !== 'png' || got.width !== 1200) {
            failures.push(`the infographic PNG failed inside the function (${image.status}): ${new TextDecoder().decode(bytes).slice(0, 400)}`);
        }

        const write = await call('/_actions/inti.updateBlockField', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ documentId: '1', blockIndex: 0, field: 'heading', value: 'x' })
        });
        if (write.status !== 403) failures.push(`an anonymous write responds ${write.status}, not 403: ${(await write.text()).slice(0, 200)}`);

        const search = await call('/api/inti/search?collection=pages&q=a');
        if (search.status !== 401) failures.push(`/api/inti/search responds ${search.status} to an anonymous user, not 401`);

        // As Kitsuden sends it: JSON, unsigned here
        const purge = await call('/api/kitsuden/purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (purge.status !== 401) failures.push(`an unsigned purge responds ${purge.status}, not 401`);
    } finally {
        process.chdir(previous);
        // On Windows the loaded native rasterizer cannot be deleted by the process that loaded it
        if (!keep) {
            try {
                rmSync(isolated, { recursive: true, force: true });
            } catch {
                // left in the temp folder
            }
        }
        else console.log(`(--keep) function kept at ${isolated}`);
    }

    if (failures.length) throw new Error(failures.join('\n  '));
    console.log(`\n✓ Vercel (Astro ${major}): the function Vercel deploys serves the page, the editor stays out, writes are guarded`);
    console.log(`✓ Vercel (Astro ${major}): an infographic renders to PNG inside the function, with no network (rasterizer traced, font embedded)`);
}

const workdir = realpathSync.native(mkdtempSync(join(tmpdir(), `inti-vercel${major}-`)));
const tarballs = join(workdir, 'tarballs');
const project = join(workdir, 'project');
mkdirSync(tarballs, { recursive: true });
mkdirSync(project, { recursive: true });
console.log(`\n=== Vercel (@astrojs/vercel ${VERCEL_ADAPTER_BY_ASTRO_MAJOR[major]}, Astro ${major}) ===\nProject: ${project}`);

try {
    const packed = PACKAGES.map((dir) => pack(dir, tarballs));
    for (const [relative, render] of Object.entries(FIXTURE)) {
        const target = join(project, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, render(packed));
    }
    run('npm', ['install', '--no-audit', '--no-fund'], project, 'npm install');
    run('npx', ['astro', 'build'], project, 'astro build');

    try {
        await checkFunction(project);
    } catch (error) {
        console.error(`\n✗ Vercel: inside the deployed function\n  ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
    }
} finally {
    if (keep) console.log(`\n(--keep) project kept at ${project}`);
    else {
        try {
            rmSync(workdir, { recursive: true, force: true });
        } catch {
            // left in the temp folder
        }
    }
}
