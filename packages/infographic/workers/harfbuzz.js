/**
 * HarfBuzz for Satori in a Cloudflare Worker.
 *
 * Satori shapes text with `harfbuzzjs`, whose loader fetches `hb.wasm` and compiles it
 * from bytes: a Worker allows neither. Alias `harfbuzzjs` to this module in your bundler
 * and it instantiates the WebAssembly module the Worker compiled at deploy time.
 *
 *   # wrangler.toml
 *   [alias]
 *   "harfbuzzjs" = "@intijs/infographic/workers/harfbuzz"
 */

import wasm from 'harfbuzzjs/hb.wasm';
import createHarfBuzz from 'harfbuzzjs/hb.js';
import hbjs from 'harfbuzzjs/hbjs.js';

// The loader reads `self.location.href` as soon as it starts, to find `hb.wasm` next to
// itself. workerd has a worker scope but no `location`: lend one for that first step only.
const lent = globalThis.location === undefined;
if (lent) Object.defineProperty(globalThis, 'location', { value: { href: 'https://worker.invalid/' }, configurable: true });

const ready = createHarfBuzz({
    instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasm, imports).then((instance) => done(instance));
        return {};
    }
});

if (lent) delete globalThis.location;

export default ready.then((instance) => hbjs(instance));
