#!/usr/bin/env node
/**
 * Checks that the documented setup builds against an Astro major.
 *
 * It exists because compatibility with Astro 5/6/7 was declared in core's
 * `peerDependencies` and verified only once, by hand. A claim that nothing
 * checks breaks without anyone noticing — just like the documentation
 * site, which for weeks built a single 404 without failing.
 *
 * It packs the packages with `npm pack` and installs them in a clean
 * project outside the workspace. Installing them via `file:` would not
 * work: npm would link them to the monorepo and the project would resolve
 * `astro` from the root instead of the major under test.
 *
 * Usage:
 *   node scripts/astro-compat.mjs 7
 *   node scripts/astro-compat.mjs 5 --keep    (does not delete the project)
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.dirname` does not exist before Node 20.11 and CI tests 18.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The Astro node adapter has its own major and its `peerDependencies` pins
 * Astro's, so the pair has to be explicit: letting npm resolve it on its
 * own fails because it does not step back across majors.
 */
const NODE_ADAPTER_BY_ASTRO_MAJOR = {
    5: '^9',
    6: '^10',
    7: '^11'
};

/** Packages that go into the test project */
const PACKAGES = ['packages/core', 'packages/adapter-wordpress'];

const major = process.argv[2];
const keep = process.argv.includes('--keep');

if (!major || !NODE_ADAPTER_BY_ASTRO_MAJOR[major]) {
    console.error(
        `Usage: node scripts/astro-compat.mjs <${Object.keys(NODE_ADAPTER_BY_ASTRO_MAJOR).join('|')}> [--keep]`
    );
    process.exit(2);
}

const adapterRange = NODE_ADAPTER_BY_ASTRO_MAJOR[major];

function run(command, args, cwd, label) {
    process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
    try {
        execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    } catch {
        console.error(`\n✗ Astro ${major}: ${label} failed`);
        process.exit(1);
    }
}

/** Packs a workspace and returns the tarball path */
function pack(packageDir, destination) {
    const output = execFileSync(
        'npm',
        ['pack', '--json', '--pack-destination', destination],
        { cwd: join(ROOT, packageDir), encoding: 'utf8', shell: process.platform === 'win32' }
    );

    // npm and `prepare` write before the JSON, sometimes with brackets: start at
    // the line that holds only the opening bracket
    const json = JSON.parse(output.slice(output.search(/^\[\s*$/m)));
    return join(destination, json[0].filename);
}

// ============================================
// The test project
// ============================================

/**
 * It is the full setup from AGENTS.md, not a "hello world": what breaks
 * across majors is the `.astro` compiler, the virtual modules
 * (`astro:actions`) and the integrations API. A project that does not
 * use them would pass the test without testing anything.
 */
const FIXTURE = {
    'package.json': (tarballs) =>
        JSON.stringify(
            {
                name: 'inti-astro-compat',
                private: true,
                type: 'module',
                version: '0.0.0',
                dependencies: {
                    astro: `^${major}`,
                    '@astrojs/node': adapterRange,
                    ...Object.fromEntries(tarballs.map(({ name, path }) => [name, `file:${path}`]))
                }
            },
            null,
            2
        ),

    'astro.config.mjs': () => `import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import inti from '@intijs/core';

export default defineConfig({
    adapter: node({ mode: 'standalone' }),
    integrations: [inti()],
    output: 'server',
    // IntiImage delegates to astro:assets, and a remote image needs its
    // domain authorized or Astro refuses to optimize it.
    image: { domains: ['images.example.com'] }
});
`,

    // astro:actions only exists with an adapter configured; this is what
    // breaks silently if the actions API changes shape.
    'src/actions/index.ts': () => `import { intiActions } from '@intijs/core/actions';

export const server = { inti: intiActions };
`,

    // `defineConfig` is imported from the root of @intijs/core, as the
    // documentation says. The page imports it directly: if the root stopped
    // exporting it, the build would fail here instead of VisualBridgeAuto
    // silently ignoring the config, which is what used to happen.
    'inti.config.ts': () => `import { defineConfig } from '@intijs/core';

export default defineConfig({ adapter: 'local' });
`,

    'src/blocks/HeroBanner.astro': () => `---
import IntiImage from '@intijs/core/image/IntiImage.astro';

const { heading, cta, image, intiBlock } = Astro.props;
---
<section>
    <h1 data-inti-field="heading">{heading}</h1>
    {cta && <a data-inti-field="cta.label" href={cta.url}>{cta.label}</a>}
    {image && (
        <IntiImage
            src={image}
            alt="Product"
            priority={intiBlock?.isFirst}
            sizes="(max-width: 768px) 100vw, 50vw"
        />
    )}
    <small>{intiBlock?.isFirst ? 'first' : 'rest'}</small>
</section>
`,

    // Delivery: CDN headers, the HTML cache, no editor markup for visitors,
    // and 404/503 decided by the error the page throws.
    'src/middleware.ts': () => `import { createCacheManager } from '@intijs/core/cache';
import { intiDelivery } from '@intijs/core/delivery';

export const cache = createCacheManager();
export const onRequest = intiDelivery({ cache });
`,

    'src/pages/api/inti/purge.ts': () => `import { purgeRoute } from '@intijs/core/delivery';
import { cache } from '../../../middleware';

export const prerender = false;
export const POST = purgeRoute({ cache, secret: 'compat-secret' });
`,

    'src/pages/fail/[kind].astro': () => `---
import { NotFoundError, UnavailableError } from '@intijs/core/errors';
import { pageErrorResponse } from '@intijs/core/server';

try {
    if (Astro.params.kind === 'missing') throw new NotFoundError('page', 'missing');
    throw new UnavailableError('CMS down', { retryAfter: 90 });
} catch (error) {
    return pageErrorResponse(error);
}
---
`,

    // Adaptive zone as a server island: the page is the same for everybody
    // and cacheable; only the island is private.
    'src/pages/zone.astro': () => `---
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';

registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const blocks = [
    { type: 'HeroBanner', data: { heading: 'DEFAULT VERSION', inti_slot: 'hero' }, meta: { index: 0 } },
    { type: 'HeroBanner', data: { heading: 'MOBILE VERSION', inti_slot: 'hero', inti_audience: 'device:mobile' }, meta: { index: 1 } },
    { type: 'HeroBanner', data: { heading: 'Always here' }, meta: { index: 2 } }
];
---
<html lang="en"><body><BlockRenderer blocks={blocks} adaptive="island" audit={false} /></body></html>
`,

    // The same route that AGENTS.md and the quick start document. It used to
    // be index.astro, and the documented dynamic route —which does not
    // compile without output: 'server'— was never tested.
    'src/pages/[...slug].astro': () => `---
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import VisualBridgeAuto from '@intijs/core/visual-bridge/VisualBridgeAuto.astro';
import IntiSeo from '@intijs/core/astro/IntiSeo.astro';
import IntiStructuredData from '@intijs/core/astro/IntiStructuredData.astro';
import { buildProductSchema, faqFromBlock } from '@intijs/core/seo';
import { WordPressAdapter } from '@intijs/adapter-wordpress';
import intiConfig from '../../inti.config';

registerBlocks(import.meta.glob('/src/blocks/*.astro'));

// Instantiated without calling the network: checks that the adapter loads
// and that its contract compiles against this major.
const adapter = new WordPressAdapter({ endpoint: 'https://example.invalid' });
const writable = adapter.writable === true;

const page = {
    id: '1',
    slug: 'home',
    title: 'Compat',
    blocks: [
        {
            type: 'HeroBanner',
            data: {
                heading: 'Hello',
                cta: { label: 'Go', url: '#' },
                // With declared dimensions, astro:assets does not need the network
                image: {
                    id: 'p1',
                    url: 'https://images.example.com/t-shirt.jpg',
                    width: 1600,
                    height: 900,
                    alt: 'T-shirt'
                }
            }
        },
        // No registered component: in dev the box explaining what is missing
        // must show; in production, nothing.
        { type: 'BlockWithoutComponent', data: { text: 'should not be visible' } },
        // Hidden in the CMS: must not reach the production HTML
        { type: 'HeroBanner', data: { heading: 'HIDDEN PROMO' }, meta: { visible: false } }
    ],
    seo: { title: 'Compat', description: 'Compatibility test' }
};

const product = buildProductSchema(
    { name: 'T-shirt', offers: { price: '9.99', availability: 'InStock' } },
    { currency: 'EUR' }
);
---
<html lang="en">
<head>
    <IntiSeo page={page} url={Astro.url.href} siteName="Compat" />
    <IntiStructuredData
        page={page}
        url={Astro.url.href}
        blockSchemas={{ FaqSection: faqFromBlock('items') }}
        extra={[product]}
    />
</head>
<body>
    <BlockRenderer blocks={page.blocks} page={page} />
    <VisualBridgeAuto />
    <p>writable: {String(writable)}</p>
    <p>config: {intiConfig.adapter}</p>
</body>
</html>
`
};

// ============================================
// Development check
// ============================================

/**
 * `astro build` is not enough. The integration once registered a dev
 * toolbar app with a path that did not exist: the build passed, and in
 * `astro dev` Vite drew its full-screen error overlay on top of the page,
 * swallowing every click. The editor —which only works in dev— was
 * unusable and no check saw it.
 *
 * Here `astro dev` is started, the page is requested and the module graph
 * the browser would request is walked, following static and dynamic
 * imports. Any response >= 400 is a failure.
 */
async function checkDev(cwd) {
    const port = 43200 + Number(major);
    const base = `http://127.0.0.1:${port}`;
    let log = '';

    const child = spawn('npx', ['astro', 'dev', '--port', String(port), '--host', '127.0.0.1'], {
        cwd,
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32'
    });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));

    const stop = () => {
        try {
            if (process.platform === 'win32') {
                execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            } else {
                process.kill(-child.pid, 'SIGTERM');
            }
        } catch {
            // it had already exited
        }
    };

    try {
        let html = null;
        for (let attempt = 0; attempt < 90 && html === null; attempt++) {
            try {
                const res = await fetch(base + '/');
                if (res.ok) html = await res.text();
            } catch {
                // still starting
            }
            if (html === null) await new Promise((r) => setTimeout(r, 1000));
        }
        if (html === null) throw new Error(`astro dev did not respond at ${base}\n${log.slice(-2000)}`);

        // The first request triggers Vite's dependency optimization. While it
        // runs, Vite has not mounted its middleware yet and Astro's router is
        // the one answering —with a 404— to `/@vite/client`. A fixed wait is
        // fragile: wait until Vite's client is served, which is exactly what
        // the browser needs first.
        let viteReady = false;
        for (let attempt = 0; attempt < 60 && !viteReady; attempt++) {
            viteReady = (await fetch(base + '/@vite/client')).ok;
            if (!viteReady) await new Promise((r) => setTimeout(r, 1000));
        }
        if (!viteReady) throw new Error(`Vite never served /@vite/client\n${log.slice(-1500)}`);

        // The versioned dependency URLs change when Vite re-optimizes
        html = await (await fetch(base + '/')).text();

        /**
         * A module can fail for a moment while Vite finishes optimizing. It
         * is retried; a real failure —like the toolbar app that pointed to a
         * nonexistent file— always fails.
         */
        const request = async (modulePath) => {
            let res;
            for (let attempt = 0; attempt < 4; attempt++) {
                res = await fetch(base + modulePath);
                if (res.ok) return res;
                await new Promise((r) => setTimeout(r, 1500));
            }
            return res;
        };

        const pending = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
        const seen = new Set();
        const failures = [];

        while (pending.length > 0 && seen.size < 400) {
            const modulePath = pending.shift();
            if (!modulePath.startsWith('/') || seen.has(modulePath)) continue;
            seen.add(modulePath);

            const res = await request(modulePath);
            if (!res.ok) {
                failures.push(`${res.status} ${modulePath}`);
                continue;
            }
            const code = await res.text();
            for (const m of code.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\/[^"']+)["']/g)) {
                pending.push(m[1]);
            }
        }

        if (/Internal server error/i.test(log)) {
            const line = log.split('\n').find((l) => /Internal server error/i.test(l));
            failures.push(`the dev server logged: ${line?.trim().slice(0, 300)}`);
        }

        // In dev, a block without a component explains which file is missing
        if (!html.includes('Missing Component')) {
            failures.push('a block without a component does not show the "Missing Component" box in dev');
        }

        if (failures.length > 0) {
            throw new Error(
                `modules the browser could not load in dev:\n  ${failures.join('\n  ')}\n\n` +
                    `--- end of the astro dev log ---\n${log.slice(-1500)}`
            );
        }

        console.log(`\n✓ Astro ${major}: astro dev serves the page and its ${seen.size} modules without errors`);
    } finally {
        stop();
    }
}

// ============================================
// Production check
// ============================================

/**
 * What an anonymous visitor of the published site receives.
 *
 * These are product promises that nothing checked: zero Inti JavaScript,
 * nothing from the editor in the HTML, hidden blocks left out, and a block
 * without a component invisible. Two scripts that did nothing reached
 * every visitor for weeks —they were all the JS on the page— without any
 * check seeing it.
 */
async function checkProduction(cwd) {
    const port = 43300 + Number(major);
    const base = `http://127.0.0.1:${port}`;
    let log = '';

    const child = spawn('node', ['./dist/server/entry.mjs'], {
        cwd,
        env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) },
        detached: process.platform !== 'win32'
    });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));

    const stop = () => {
        try {
            if (process.platform === 'win32') {
                execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            } else {
                process.kill(-child.pid, 'SIGTERM');
            }
        } catch {
            // it had already exited
        }
    };

    try {
        let res = null;
        for (let attempt = 0; attempt < 30 && res === null; attempt++) {
            try {
                res = await fetch(base + '/');
            } catch {
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
        if (res === null) throw new Error(`the production server did not respond\n${log.slice(-1500)}`);

        const html = await res.text();
        const failures = [];

        if (res.status !== 200) failures.push(`the page responds ${res.status}`);

        const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*>/g)].map((m) => m[0]);
        if (scripts.length > 0) failures.push(`the visitor receives JavaScript: ${scripts.join(' ')}`);

        if (html.includes('data-inti-block-json')) failures.push('the HTML embeds the block data');
        if (html.includes('data-inti-inline-editor')) failures.push('the HTML includes the editor');
        if (html.includes('HIDDEN PROMO')) failures.push('a block hidden in the CMS reaches the HTML');
        if (html.includes('Missing Component') || html.includes('should not be visible')) {
            failures.push('a block without a component shows in production');
        }
        if (!html.includes('srcset=')) failures.push('<IntiImage> does not emit srcset');

        if (html.includes('data-inti-field')) failures.push('the visitor receives the editor attributes (data-inti-field)');
        if (!/s-maxage=\d+/.test(res.headers.get('cache-control') ?? '')) {
            failures.push(`an anonymous page is not CDN-cacheable: Cache-Control "${res.headers.get('cache-control')}"`);
        }
        const again = await fetch(base + '/?utm_source=compat');
        if (again.headers.get('x-inti-cache') !== 'HIT') failures.push('the HTML cache does not serve the second visit (tracking parameters must not split it)');
        await again.text();

        const missing = await fetch(base + '/fail/missing');
        if (missing.status !== 404) failures.push(`a missing page answers ${missing.status}, not 404`);
        const down = await fetch(base + '/fail/down');
        if (down.status !== 503 || down.headers.get('retry-after') !== '90') {
            failures.push(`a CMS that is down answers ${down.status} (Retry-After ${down.headers.get('retry-after')}), not 503 with Retry-After 90`);
        }

        const zone = await fetch(base + '/zone');
        const zoneHtml = await zone.text();
        if (!/s-maxage=\d+/.test(zone.headers.get('cache-control') ?? '')) {
            failures.push(`a page with an adaptive zone in island mode is not cacheable: "${zone.headers.get('cache-control')}"`);
        }
        if (!zoneHtml.includes('DEFAULT VERSION') || zoneHtml.includes('MOBILE VERSION') || !zoneHtml.includes('Always here')) {
            failures.push('the cacheable page must carry the default version of the zone, and only that one');
        }
        // The request the island's own script makes: GET with the props in the
        // query when they fit in a URL, POST with them in the body otherwise
        // GET: Astro also preloads the URL in a <link>. POST: only the script has it
        const preload = zoneHtml.match(/<link rel="preload" as="fetch" href="(\/_server-islands\/[^"]+)"/)?.[1];
        const islandCall = preload
            ? [preload, preload]
            : zoneHtml.match(/fetch\(['"`](\/_server-islands\/[^'"`]+)['"`](?:, \{\s*method: 'POST')?/);
        const islandData = zoneHtml.match(/let data = (\{[\s\S]*?\});\s*const headers/)?.[1];
        if (!islandCall) {
            const at = zoneHtml.indexOf('_server-islands');
            failures.push(`the adaptive zone is not rendered as a server island: ${at < 0 ? zoneHtml.slice(0, 600) : zoneHtml.slice(Math.max(0, at - 400), at + 900)}`);
        } else {
            const mobile = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
            const post = islandCall[0].includes('POST') && islandData;
            const island = await fetch(base + islandCall[1].replace(/&amp;/g, '&'), {
                method: post ? 'POST' : 'GET',
                headers: { 'user-agent': mobile, ...(post ? { 'content-type': 'application/json' } : {}) },
                // The script's object literal has a trailing comma, which JSON does not accept
                body: post ? JSON.stringify(Function(`return (${islandData})`)()) : undefined
            });
            const islandHtml = await island.text();
            if (!islandHtml.includes('MOBILE VERSION')) failures.push(`the island does not pick the visitor's version (${island.status}): ${islandHtml.slice(0, 200)}`);
            if (!/private/.test(island.headers.get('cache-control') ?? '')) failures.push('the island response is not private');
        }

        const search = await fetch(base + '/api/inti/search?collection=pages&q=a');
        if (search.status !== 401) failures.push(`/api/inti/search responds ${search.status} to an anonymous user, not 401`);

        if (failures.length > 0) {
            throw new Error(`in production:\n  ${failures.join('\n  ')}`);
        }

        console.log(`\n✓ Astro ${major}: in production the visitor gets the page with no JS and nothing from the editor`);
    } finally {
        stop();
    }
}

// ============================================
// Run
// ============================================

// On Windows, tmpdir() returns the 8.3 short path (C:/Users/ABCDEF~1/...).
// Vite resolves real paths, and with the root in short form its own files
// end up "outside" the project: `astro dev` never got to serve
// /@vite/client. Work with the real path.
const workdir = realpathSync.native(mkdtempSync(join(tmpdir(), `inti-compat-astro${major}-`)));
const tarballDir = join(workdir, 'tarballs');
const project = join(workdir, 'project');

mkdirSync(tarballDir, { recursive: true });
mkdirSync(project, { recursive: true });

console.log(`\n=== Astro ${major} (node adapter ${adapterRange}) ===`);
console.log(`Project: ${project}`);

try {
    const tarballs = PACKAGES.map((packageDir) => ({
        name: JSON.parse(
            execFileSync('node', ['-p', `JSON.stringify(require('./${packageDir}/package.json').name)`], {
                cwd: ROOT,
                encoding: 'utf8'
            }).trim()
        ),
        path: pack(packageDir, tarballDir)
    }));

    for (const [relative, render] of Object.entries(FIXTURE)) {
        const target = join(project, relative);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, render(tarballs));
    }

    run('npm', ['install', '--no-audit', '--no-fund'], project, 'npm install');
    run('npx', ['astro', 'build'], project, 'astro build');

    try {
        await checkDev(project);
    } catch (error) {
        console.error(`
✗ Astro ${major}: astro dev failed
${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
        throw error;
    }

    try {
        await checkProduction(project);
    } catch (error) {
        console.error(`\n✗ Astro ${major}: failed in production\n${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
        throw error;
    }

    console.log(`\n✓ Astro ${major}: the documented setup builds correctly`);
} finally {
    if (keep) {
        console.log(`\n(--keep) project kept at ${project}`);
    } else {
        rmSync(workdir, { recursive: true, force: true });
    }
}
