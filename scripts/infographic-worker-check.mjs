#!/usr/bin/env node
/**
 * Renders an infographic inside workerd, Cloudflare's runtime, locally with Miniflare.
 *
 * A Worker cannot fetch or compile WebAssembly at runtime, so this is the setup the
 * README documents: Satori 0.35.0's standalone build with its layout engine, HarfBuzz
 * through `@intijs/infographic/workers/harfbuzz`, and resvg's WebAssembly build, all
 * imported as compiled modules, with no `nodejs_compat`.
 *
 * It checks the sizes of a JPEG (Instagram) and a PNG (blog), and that the SVG drawn in
 * the Worker is byte for byte the one Node draws with the same Satori and fonts: a font
 * the shaper cannot read would still give images of the right size, full of
 * "NO GLYPH" boxes.
 *
 * Usage: node scripts/infographic-worker-check.mjs   Requires `npm run build`.
 *        INFOGRAPHIC_OUT=<dir> also writes the images there.
 */

import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'packages/infographic/package.json'));

const DATA = {
    title: 'Sales by channel',
    source: 'CRM',
    sections: [
        { kind: 'kpis', items: [{ label: 'Revenue', value: 1284500, format: 'currency', currency: 'EUR', delta: 12.5 }] },
        { kind: 'bar', title: 'Channels', items: [{ label: 'Web', value: 120 }, { label: 'Store', value: 80 }] }
    ]
};

const WORKER = `
import satori, { init as initLayout } from 'satori-workers/standalone';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { renderInfographic, resvgRasterizer } from '@intijs/infographic';
import layoutWasm from 'satori-workers/yoga.wasm';
import resvgWasm from './resvg.wasm';
import font400 from './inter-400.woff';
import font800 from './inter-800.woff';

let ready;
const setup = () => (ready ??= Promise.all([initLayout(layoutWasm), initWasm(resvgWasm)]));
const data = ${JSON.stringify(DATA)};

export default {
    async fetch(request) {
        try {
            await setup();
            const url = new URL(request.url);
            const { slides } = await renderInfographic(data, {
                format: url.searchParams.get('format') ?? 'blog',
                output: url.searchParams.get('output') ?? undefined,
                satori,
                rasterizer: resvgRasterizer(Resvg),
                fonts: [
                    { name: 'Inter', data: font400, weight: 400 },
                    { name: 'Inter', data: font800, weight: 800 }
                ]
            });
            return new Response(slides[0].bytes, { headers: { 'content-type': slides[0].contentType } });
        } catch (error) {
            return new Response(String((error && error.stack) || error), { status: 500 });
        }
    }
};
`;

function size(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) };
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        for (let offset = 2; offset < bytes.length; ) {
            const marker = bytes[offset + 1];
            if (marker >= 0xc0 && marker <= 0xc2) return { type: 'jpeg', width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
            offset += 2 + view.getUint16(offset + 2);
        }
    }
    return { type: 'unknown' };
}

const file = (id) => readFileSync(require.resolve(id));
const fontFiles = { 400: '@fontsource/inter/files/inter-latin-400-normal.woff', 800: '@fontsource/inter/files/inter-latin-800-normal.woff' };

async function main() {
    const bundle = await build({
        stdin: { contents: WORKER, resolveDir: join(ROOT, 'packages/infographic'), loader: 'js' },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        conditions: ['workerd', 'worker', 'browser'],
        // Bindings of the Worker, or code that only runs in Node
        external: ['satori-workers/yoga.wasm', 'harfbuzzjs/hb.wasm', './resvg.wasm', './inter-400.woff', './inter-800.woff', '@resvg/resvg-js', 'node:module', 'node:fs/promises', 'fs', 'path'],
        plugins: [
            {
                // What wrangler's [alias] does in a real project
                name: 'worker-aliases',
                setup(b) {
                    b.onResolve({ filter: /^satori$/ }, (args) => b.resolve('satori-workers/standalone', { resolveDir: args.resolveDir, kind: args.kind }));
                    b.onResolve({ filter: /^harfbuzzjs$/ }, () => ({ path: join(ROOT, 'packages/infographic/workers/harfbuzz.js') }));
                }
            }
        ],
        logLevel: 'warning'
    });
    const code = bundle.outputFiles[0].text;

    const mf = new Miniflare({
        compatibilityDate: '2026-01-01',
        modulesRoot: '/',
        modules: [
            { type: 'ESModule', path: '/worker.mjs', contents: code },
            { type: 'CompiledWasm', path: '/satori-workers/yoga.wasm', contents: file('satori-workers/yoga.wasm') },
            { type: 'CompiledWasm', path: '/harfbuzzjs/hb.wasm', contents: readFileSync(join(dirname(require.resolve('harfbuzzjs')), 'hb.wasm')) },
            { type: 'CompiledWasm', path: '/resvg.wasm', contents: file('@resvg/resvg-wasm/index_bg.wasm') },
            { type: 'Data', path: '/inter-400.woff', contents: file(fontFiles[400]) },
            { type: 'Data', path: '/inter-800.woff', contents: file(fontFiles[800]) }
        ]
    });

    const results = [];
    const report = (ok, line) => {
        results.push(ok);
        console.log(`${ok ? '✓' : '✗'} ${line}`);
    };
    const fetchWorker = async (query) => {
        const response = await mf.dispatchFetch(`http://worker/?${query}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${new TextDecoder().decode(bytes).slice(0, 400)}`);
        return bytes;
    };

    try {
        for (const [format, expected] of [
            ['instagram-portrait', { type: 'jpeg', width: 1080, height: 1350 }],
            ['blog', { type: 'png', width: 1600, height: 900 }]
        ]) {
            const bytes = await fetchWorker(`format=${format}`);
            if (process.env.INFOGRAPHIC_OUT) writeFileSync(join(process.env.INFOGRAPHIC_OUT, `worker-${format}.${expected.type === 'jpeg' ? 'jpg' : 'png'}`), bytes);
            const got = size(bytes);
            report(JSON.stringify(got) === JSON.stringify(expected), `${format} in workerd → ${JSON.stringify(got)}`);
        }

        // The same drawing as Node with the same Satori: text included
        const workerSvg = new TextDecoder().decode(await fetchWorker('format=og&output=svg'));
        const { renderInfographic } = await import(pathToFileURL(join(ROOT, 'packages/infographic/dist/index.js')).href);
        // The ESM build: resolving the bare name from here lands on the CommonJS one
        const satori = (await import(pathToFileURL(join(dirname(require.resolve('satori-workers/package.json')), 'dist/index.js')).href)).default;
        const fonts = Object.entries(fontFiles).map(([weight, id]) => ({ name: 'Inter', data: file(id), weight: Number(weight) }));
        const { slides } = await renderInfographic(DATA, { format: 'og', output: 'svg', satori, fonts });
        report(workerSvg === slides[0].svg, `the Worker draws the same SVG as Node (${(workerSvg.length / 1024).toFixed(0)} KB)`);

        console.log(`\nWorker bundle: ${(code.length / 1024).toFixed(0)} KB of JavaScript`);
    } finally {
        await mf.dispose();
    }
    if (results.includes(false)) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
