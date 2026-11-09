# @intijs/cli

Generates TypeScript types from your CMS schema. Part of [Inti](https://github.com/intijs/inti), currently in beta.

```bash
npm install -D @intijs/cli
npx inti sync
```

`inti sync` reads `inti.config.ts`, asks the adapter for the schema, and writes to `outputDir` (`./src/lib/inti` by default):

| File | Contents |
|---|---|
| `inti.types.ts` | One interface per block type, plus `IntiTypedBlock`, a union discriminated by `type` |
| `inti-manifest.json` | The block manifest for AI tools |
| `inti-mocks.ts` | Sample data |

```ts
// inti.config.ts
import { defineConfig } from '@intijs/core';

export default defineConfig({
  adapter: 'wordpress',
  adapterConfig: { endpoint: process.env.INTI_WP_ENDPOINT }
});
```

```ts
import type { IntiTypedBlock } from './lib/inti/inti.types';

const blocks = page.blocks as IntiTypedBlock[];
if (blocks[0].type === 'hero') blocks[0].data.headline; // string
```

It generates types, not a fetch SDK: content is always read with the adapter. See the [guide](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/cli/sync.mdx).

MIT
