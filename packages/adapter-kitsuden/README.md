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

- **Writes** address each block row by its uuid, and the adapter checks the API's contract versions before the first one.
- **Game pages** (`game:<uuid>`): only `title` and `description` are edited, in the block's editorial layer (`PATCH /api/games/:id/blocks/:blockId/editorial`); removing a block hides it (`hidden: true`) and moving one writes `PUT /api/games/:id/blocks/order`. These need Kitsuden 0.9 or later (`games` and `games-editorial` contracts v2, English keys).
- **Drafts** are clones the panel can also see. Publishing keeps the page's id, slug and homepage flag.
- **Generative UI:** `generatorBlockTypes()` derives the vocabulary from the CMS palette. Media fields are offered only when you give a source to choose from, so a model cannot invent an image id.

See the [full guide](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/adapters/kitsuden.mdx).

MIT
