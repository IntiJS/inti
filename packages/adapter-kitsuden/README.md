# @intijs/adapter-kitsuden

Edit [Kitsuden](https://github.com/Kitsuden/kitsuden) Page Builder content by double-clicking the rendered page. Part of [Inti](https://github.com/intijs/inti), currently in beta.

> **Not on npm yet.** The `@intijs` packages will be published there. Until then the `npm install` command below answers 404: install from git as described under [Installation](https://github.com/intijs/inti#-installation) in the repository README.

```bash
npm install @intijs/core @intijs/adapter-kitsuden
```

```ts
import { KitsudenAdapter } from '@intijs/adapter-kitsuden';

const adapter = new KitsudenAdapter({ endpoint: 'https://cms.example.com' });
const page = await adapter.getPage('home');
```

```bash
# .env — server only, never PUBLIC_
INTI_ADAPTER=kitsuden
INTI_KITSUDEN_ENDPOINT=https://cms.example.com
INTI_KITSUDEN_TOKEN=kitsuden_agent_…   # an agent key with the scope content:edit
```

Reading published pages needs no key. Block types keep their Kitsuden name: `hero` renders with `src/blocks/hero.astro`.

- **Writes** address each block row by its uuid, and the adapter checks the API's contract versions before the first one. The editor sends the id of the block it rendered, so an edit made after someone reordered the page still reaches that block, or writes nothing.
- **Safe under load:** a 429 waits Kitsuden's `retry_after` and retries with the same `Idempotency-Key`; a read Kitsuden cannot answer throws `KitsudenUnavailableError` so the site can answer 503; anonymous reads are revalidated with ETags. `siteKey` + `clientIp` count reads per visitor.
- **Optional contracts:** with `page-builder-publish` a draft is published in one transaction, with `page-builder-patch` an edit sends only its field. Without them the adapter falls back, and publishing shows the new blocks before removing the old ones, so a page is never left empty.
- **Game pages** (`game:<uuid>`): only `title` and `description` are edited, in the block's editorial layer (`PATCH /api/games/:id/blocks/:blockId/editorial`); removing a block hides it (`hidden: true`) and moving one writes `PUT /api/games/:id/blocks/order`. These need Kitsuden 0.9 or later (`games` and `games-editorial` contracts v2, English keys).
- **Drafts** are clones the panel can also see. Publishing keeps the page's id, slug and homepage flag.
- **Generative UI:** `generatorBlockTypes()` derives the vocabulary from the CMS palette. Media fields are offered only when you give a source to choose from, so a model cannot invent an image id.

### In an Astro site

`@intijs/adapter-kitsuden/astro` has what every Kitsuden site used to copy: `kitsudenMiddleware` (editor sessions looked up only with a Kitsuden cookie and remembered for a few seconds, visitor IP, and delivery through the core's `intiDelivery`: HTML cache, CDN headers, editor markup only for editors, 503 when Kitsuden is down), `purgeRoute` (a signed Kitsuden webhook empties the core cache), `mediaPresetRoute` / `mediaFileRoute` / `imageSrc` (media from the site's origin, Range for video), `kitsudenImage` + `mediaTransformRoute` (AVIF, WebP and `srcset` from `/transform`, cached as immutable), the `data-inti-*` markup helpers, `stripSecretsForBuild` and `kitsudenActions`.

The adapter also has `getRenderedPage(slug)` (`/render/:slug`, visible blocks with their styles), `fetchNavigation()` (`mainNav` from the settings), `search()` (`/api/search`), conditional writes (`If-Match` with the block's version, no read first, a 409 when it changed) and `kitsudenCatalogSource` (a dataset as a catalog).

```ts
// src/middleware.ts
import { createCacheManager } from '@intijs/core/cache';
import { kitsudenMiddleware } from '@intijs/adapter-kitsuden/astro';

export const cache = createCacheManager({ defaultTtl: 60, staleIfError: 86_400 });
export const onRequest = kitsudenMiddleware({ api: process.env.KITSUDEN_API_URL!, cache });
```

See the [full guide](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/adapters/kitsuden.mdx).

MIT
