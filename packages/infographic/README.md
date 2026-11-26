# @intijs/infographic

Data infographics and dashboards for Astro sites, built from a CMS block. One block renders two ways from the same tree:

- **On the page**: real text and inline SVG that scale to any width (container units, no media queries), editable with a double click like any Inti block, and readable by search engines and AI crawlers.
- **As images**: a single image or a carousel, sized for each platform, with alt text written from the numbers.

| Format | Size | File | Notes |
|---|---|---|---|
| `instagram-portrait` | 1080×1350 (4:5) | JPEG | Feed post. The profile grid crops it to 3:4; the padding covers that |
| `instagram-square` | 1080×1080 | JPEG | Feed post |
| `instagram-story` | 1080×1920 (9:16) | JPEG | The top and bottom 250 px are left clear for the interface |
| `tiktok` | 1080×1920 (9:16) | JPEG | Clear of the caption (bottom 440 px), the buttons (right 140 px) and the tabs (top 160 px). Up to 35 images, as photo mode allows |
| `blog` | 1600×900 (16:9) | PNG | Two columns, like a dashboard |
| `og` | 1200×630 | PNG | The preview when the post is shared. One image |

Instagram's publishing API only accepts JPEG, which is why its formats default to it. The safe zones follow what each interface covers today; adjust them with `defineFormat` when that changes.

> **In beta (0.1), and not on npm yet.** Install it from git as the [main README](../../README.md#installation) describes. `npm install @intijs/infographic` will work once the packages are published.

## What a block can hold

An infographic has a header (`eyebrow`, `title`, `subtitle`, `brand`, `logo`), a footer (`source`, `date`, `footnote`) and a list of `sections`. Each section is one of these kinds:

| Kind | For | Data |
|---|---|---|
| `kpis` | Headline numbers as tiles, with change (▲/▼, coloured by whether up is good) and a sparkline | `items: [{ label, value, delta, goodWhen, trend }]` |
| `stat` | One big number and a sentence | `value`, `label`, `text` |
| `bar` | Comparing or ranking categories; negative values grow left from zero | `items` or `data` |
| `column` | A value over a few periods | `items` or `data` |
| `line`, `area` | A trend; up to 4 series; a missing value breaks the line | `data` as a table |
| `donut`, `share` | Parts of a whole; past 6 slices the smallest fold into "Other" | `items` or `data` |
| `waffle` | One to three percentages on a 10×10 grid | `items` |
| `progress` | Progress towards goals | `items: [{ label, value, max }]` |
| `gauge` | One value against a maximum | `value`, `max` |
| `funnel` | Steps that lose people, with the conversion between each | `items` |
| `heatmap` | A value across two dimensions, on a one-hue scale with its legend | `data` as a table |
| `table` | Exact figures; numeric columns right-aligned; highlighted rows | `data`, `highlightRows` |
| `comparison` | Two options row by row, marking the better one | `leftLabel`, `rightLabel`, `items: [{ label, left, right, better }]` |
| `timeline` | Dated events | `items: [{ date, title, text }]` |
| `steps` | A numbered process | `items: [{ title, text }]` |
| `text` | A paragraph, or a quotation with `quote` and `author` | `text` |

Numbers are formatted for the block's `locale` with `format`: `number`, `compact` ("1,3 M"), `percent` (45 means 45 %), `currency` (with `currency: 'EUR'`) or `decimal`; plus `decimals`, `prefix` and `suffix`. A chart uses one notation for all its values.

`data` accepts what a CMS actually stores: a table typed or pasted into a text field (one row per line; cells separated by tab, `;` or `,`; a first row of names is a header), an array of arrays, an array of objects, or the value a `@intijs/genui` data source resolves to. Numbers like `"1.234,5"` and `"1,234.5"` are both read correctly; anything that is not a number is drawn as missing, never as zero.

```json
{
  "title": "Mobile sales doubled in a year",
  "source": "Internal analytics",
  "locale": "en",
  "sections": [
    { "kind": "kpis", "items": [{ "label": "Revenue", "value": 1284500, "format": "currency", "currency": "EUR", "delta": 18.4, "trend": "12 14 13 17 19 22" }] },
    { "kind": "line", "title": "Mobile overtook desktop in March", "format": "compact", "data": "Month;Mobile;Desktop\nJan;120000;180000\nFeb;140000;175000\nMar;185000;170000" }
  ]
}
```

## On the page

```astro
---
// src/blocks/infographic.astro — the block type is `infographic`
import Infographic from '@intijs/infographic/Infographic.astro';
---
<Infographic data={Astro.props} format="blog" />
```

`format` sets the proportions the figure keeps; the page version shows every section in one figure, without pagination. Titles, labels and texts carry `data-inti-field`, so they are edited on the page. Numbers are not bound: a number edited as text would change its type in the CMS.

`renderInfographicHtml(data, options)` returns the same markup as a string.

## As images

```ts
import { renderInfographic } from '@intijs/infographic';

const { slides, warnings } = await renderInfographic(block.data, { format: 'instagram-portrait' });
// slides: [{ bytes, contentType: 'image/jpeg', width: 1080, height: 1350, alt, index, total }]
```

What does not fit continues on the next image. Fitting is measured with the real fonts, not guessed. A chart that fits on an image of its own is never split; a long table, list or bar chart continues across images with the same scale, and steps keep their numbering. More images than the platform takes are dropped with a warning.

- `planInfographic(data, options)` says how many images a format needs and their alt text, without rendering pixels.
- `fonts`: TTF, OTF or WOFF (not WOFF2). Optional: see [Fonts](#fonts).
- `rasterizer`: rendering to PNG or JPEG needs `@resvg/resvg-js` installed (an optional peer dependency). `output: 'svg'` needs nothing.
- `imageOrigins`: a `logo` is drawn only from these origins or as a `data:` image. Nothing else is fetched.

## An endpoint for automations

`@intijs/infographic/route` serves a page's infographic blocks by URL, so n8n, a scheduler or a social tool can fetch them:

```ts
// src/pages/infographics/[...path].ts
import { createInfographicRoute } from '@intijs/infographic/route';
import { readPage } from '../../lib/cms';

export const GET = createInfographicRoute({ readPage, blockTypes: ['infographic'] });
```

| URL | Returns |
|---|---|
| `/infographics/<slug>/<block>.json?format=tiktok` | How many images, their URLs and alt text |
| `/infographics/<slug>/<block>.jpg?format=instagram-portrait&slide=2` | One image |
| `/infographics/<slug>/<block>.png?format=blog` | One image |

`<block>` is the block's `meta.index`. The route reads the published page (pass a reader that never returns drafts), renders only the block types you list and returns 404 for a block that scheduled visibility hides. Responses carry an `ETag` and `Cache-Control`; renders are cached in memory and run two at a time (`concurrency`), because rendering is CPU work. At most `maxQueue` requests (default 32) wait for a slot; beyond that the route answers `503` with `Retry-After`. `?theme=` must name a declared theme (`400` otherwise), so a made-up name cannot force a fresh render. Put a CDN in front for traffic.

A typical n8n flow: fetch the `.json`, then publish each `url` to Instagram as a carousel item (its API fetches the image from that URL, so the site must be public) with the `alt`.

## With @intijs/genui

```ts
// src/lib/infographic.ts
import { infographicVocabulary } from '@intijs/infographic';

export const infographicBlock = infographicVocabulary({ datasets: 'metrics' });
// A data source: { id, summary, value } where value is the table
export const metrics = [{ id: 'q3-sales', summary: 'Sales by region, Q3 2026', value: 'Region;Sales\nNorth;412000\nSouth;298000' }];
```

Add `infographicBlock` to the `blockTypes` of `<VisualBridgeAuto />` and `metrics` to the `sources` of `createBlockGenerator`, as with any other block ([generative UI](../../apps/docs/src/content/docs/guides/generative-ui.mdx)).

The model picks section kinds, writes titles and labels, and chooses a declared theme. With `datasets`, every number comes from that data source by id: the value fields are removed from the vocabulary, so a figure cannot come from the model. Without it, the rule tells the model to use only numbers given in the request.

What the CMS stores for a data field is the id. Give the renderer the same tables to draw it: `<Infographic data={Astro.props} datasets={{ 'q3-sales': … }} />`, or `datasets` in `renderInfographic` and the route. It also takes a function, `(id) => table`, to look one up. An id with no table draws an empty chart rather than an invented one.

## Themes and colour

`light`, `dark` and `sun`, or your own with `defineTheme('light', { name: 'brand', accent: '#…', series: [...] })`. The block picks a theme by name and cannot pass a colour. Categorical colours follow a fixed order chosen so adjacent series stay apart for colour-vision deficiencies; a ninth category folds into "Other". Good and bad always come with an arrow and a sign, never colour alone.

## Runtimes

**Node** (and Bun): nothing to set up beyond `@resvg/resvg-js`.

**Cloudflare Workers**: a Worker can neither fetch nor compile WebAssembly at runtime; every engine has to arrive as a module compiled at deploy time. Satori shapes text with HarfBuzz, and only up to Satori 0.35.0 does HarfBuzz come as a separate package (`harfbuzzjs`) that can be swapped for one that takes a compiled module; later versions embed it. Satori 0.35.0 is also past the SVG escaping fix (GHSA-wx4j-mvgx-mqwp, fixed in 0.33.5). Install it under another name, with the WebAssembly build of resvg:

```bash
npm install satori-workers@npm:satori@0.35.0 @resvg/resvg-wasm
```

```toml
# wrangler.toml: the package's own `satori` import, and Satori's HarfBuzz
[alias]
"satori" = "satori-workers/standalone"
"harfbuzzjs" = "@intijs/infographic/workers/harfbuzz"
```

```ts
import satori, { init } from 'satori-workers/standalone';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { renderInfographic, resvgRasterizer } from '@intijs/infographic';
import yoga from 'satori-workers/yoga.wasm';
import resvg from '@resvg/resvg-wasm/index_bg.wasm';
let ready: Promise<unknown> | undefined;

export default {
  async fetch(request: Request) {
    await (ready ??= Promise.all([init(yoga), initWasm(resvg)]));
    const { slides } = await renderInfographic(data, { format: 'instagram-portrait', satori, rasterizer: resvgRasterizer(Resvg) });
    return new Response(slides[0].bytes, { headers: { 'content-type': slides[0].contentType } });
  }
};
```

The built-in themes need no fonts: Inter is embedded. For another typeface, import its WOFF files as data modules (a `[[rules]]` entry of type `Data` for `**/*.woff`) and pass them as `fonts`. WOFF is unwrapped to TrueType before shaping, because HarfBuzz cannot read it; WOFF2 is refused. `npm run test:infographic-worker` runs this setup in workerd, without `nodejs_compat`, and checks that the Worker draws byte for byte the SVG Node draws with the same Satori.

`renderInfographicHtml` and the Astro component have no runtime requirement.

## Fonts

Without `fonts`, the built-in themes use **Inter, embedded in the package** (400, 600 and 800, Latin and Latin Extended; SIL Open Font License, in `fonts/OFL.txt`). It needs no disk and no network, so it renders the same in Node, inside a Vercel or Netlify function, and in a Worker. A theme with another `fontFamily` uses an installed `@fontsource/<family>` package, and only when that is missing fetches the font from Google Fonts, once per process. `loadFontsource(family)` and `loadGoogleFont(family)` are exported if you want to load them yourself.

On Vercel or Netlify, a Fontsource package other than Inter has to be listed in the function's included files: their tracers only ship files the code names literally.

## Security note: `fflate`

Satori pins `fflate@0.7.3`, which has an advisory (GHSA-px8p-9vwx-vf98) in `unzipSync` with ZIP64 archives. Satori only calls `inflateSync`, to read WOFF fonts, so the vulnerable path is not reached. To clear the audit warning, override it in your project:

```json
{ "overrides": { "fflate": "^0.8.3" } }
```

This repository does the same, and its tests run against the overridden version.

## License

MIT
