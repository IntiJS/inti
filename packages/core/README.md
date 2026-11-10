# @intijs/core

> **AI for any CMS, without changing the CMS** — for sites built with Astro. Inti is not a plugin you install inside your CMS: it renders your site with Astro and saves edits back to the CMS you already have.

[![Astro](https://img.shields.io/badge/Astro-5%20%7C%206%20%7C%207-BC52EE?logo=astro)](https://astro.build)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The core package of [Inti](https://github.com/intijs/inti): the adapter contract, `BlockRenderer`, the on-page editor, the write actions and the plugin API. Content stays in your CMS; editors change it by double-clicking on the rendered page.

> **Beta.** Inti is at 0.1: it works and is ready to try, and its APIs may still change before 1.0.

> **Not on npm yet.** The `@intijs` packages will be published there. Until then `npm install @intijs/…` answers 404: install from git as described under [Installation](https://github.com/intijs/inti#-installation) in the repository README, or scaffold a whole project with its Quick start.

---

## Install

Once the packages are published:

```bash
npm install @intijs/core @intijs/adapter-wordpress    # or the adapter you use
npx astro add node                                    # node | vercel | cloudflare | netlify
```

The Astro adapter is required for editing: edits are saved through `astro:actions`, which only exist when Astro has an adapter.

## Setup: no step is optional

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import inti from '@intijs/core';

export default defineConfig({
  output: 'server',                        // pages are read from the CMS per request
  adapter: node({ mode: 'standalone' }),   // required for editing
  integrations: [inti()]
});
```

```ts
// src/actions/index.ts: the actions that receive the edits, on the server
import { intiActions } from '@intijs/core/actions';
export const server = { inti: intiActions };
```

```astro
---
// src/pages/[...slug].astro
import { WordPressAdapter } from '@intijs/adapter-wordpress';
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import VisualBridgeAuto from '@intijs/core/visual-bridge/VisualBridgeAuto.astro';

// Each file in src/blocks is a block type: the file name is the type
registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const adapter = new WordPressAdapter({ endpoint: import.meta.env.INTI_WP_ENDPOINT });
const page = await adapter.fetchPageBySlug(Astro.params.slug ?? 'home');
---
<BlockRenderer blocks={page.blocks} />
<VisualBridgeAuto />
```

```astro
---
// src/blocks/HeroBanner.astro: the CMS fields arrive as props
const { heading, subheading } = Astro.props;
---
<section>
  <h1 data-inti-field="heading">{heading}</h1>
  <p data-inti-field="subheading">{subheading}</p>
</section>
```

In development, hover a text, double-click, edit and press Enter: the change is written to the CMS. A block type with no component renders a labelled placeholder in development that names the file to add.

The canonical version of this setup, with every import path, is [`AGENTS.md`](https://github.com/intijs/inti/blob/main/AGENTS.md).

## With no CMS

`LocalAdapter` stores pages in `.inti/content.json` and implements the same write contract as the CMS adapters. It is for trying out editing and for examples, not a CMS.

```ts
import { LocalAdapter } from '@intijs/core/adapters/local';

const adapter = new LocalAdapter();
const page = await adapter.fetchPageBySlug('home');
```

## Who may edit

In development anyone can edit. In production Inti refuses every write, and does not show the editor, until a plugin decides who is editing. Register it in `src/middleware.ts` (not in `src/actions/index.ts`: Astro only loads that module with the first action):

```ts
// src/middleware.ts
import { defineMiddleware } from 'astro:middleware';
import { registerIntiPlugin } from '@intijs/core/plugins';

registerIntiPlugin({
  name: 'session',
  // Who is asking: null = nobody identified
  resolveActor: async (ctx) => (await mySession(ctx.request)) ?? null,
  // Whether they may write
  beforeWrite: (ctx) => ({ allowed: Boolean(ctx.actor) })
});

export const onRequest = defineMiddleware((_context, next) => next());
```

`mySession` is yours: Inti has no user management. See [securing writes](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/securing-writes.md).

## Interactive components

Astro already mixes React, Vue, Svelte and Solid on one page. Put the `client:*` directive inside the block, on a statically imported component:

```astro
---
// src/blocks/Carousel.astro
import Carousel from '../components/Carousel.svelte';
const { title, slides } = Astro.props;
---
<h2 data-inti-field="title">{title}</h2>
<Carousel client:visible slides={slides} />
```

## Entry points

| Import | What it gives you |
|---|---|
| `@intijs/core` | The Astro integration (`inti()`, default export) and `defineConfig` for `inti.config.ts` |
| `@intijs/core/actions` | `intiActions`, the write actions |
| `@intijs/core/registry` | `registerBlocks` |
| `@intijs/core/astro/BlockRenderer.astro` | Renders a page's blocks with your components |
| `@intijs/core/astro/IntiSeo.astro`, `IntiStructuredData.astro` | Head tags and JSON-LD from `page.seo` |
| `@intijs/core/visual-bridge/VisualBridgeAuto.astro` | The on-page editor |
| `@intijs/core/adapters` | `IntiAdapter` and the `WritableAdapter` contract, to write an adapter |
| `@intijs/core/adapters/local` | `LocalAdapter` |
| `@intijs/core/server` | Server helpers such as `env` and `readDraftPage` |
| `@intijs/core/plugins` | `registerIntiPlugin` (`resolveActor`, `beforeWrite`, `afterWrite`) |
| `@intijs/core/types` | `IntiPage`, `IntiBlock` and the other shared types |

## Adapters

| CMS | Package | Write-back |
|---|---|---|
| WordPress | `@intijs/adapter-wordpress` | yes |
| Kitsuden | `@intijs/adapter-kitsuden` | yes |
| Strapi v4 and v5 | `@intijs/adapter-strapi` | yes |
| Keystatic | `@intijs/adapter-keystatic` | yes |
| Contentful | `@intijs/adapter-contentful` | read only |
| Sanity | `@intijs/adapter-sanity` | read only |

Any adapter that implements `WritableAdapter` gets inline editing.

## Documentation

- [Getting started](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/quickstart.mdx)
- [Adapters](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/adapters/contract.mdx)
- [Securing writes](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/securing-writes.md)
- [Deployment](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/deployment.md)

## Contributing

See the [contributing guide](https://github.com/intijs/inti/blob/main/CONTRIBUTING.md).

## License

MIT
