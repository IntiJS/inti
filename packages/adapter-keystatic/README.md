# @intijs/adapter-keystatic

Edit [Keystatic](https://keystatic.com) content by double-clicking the rendered page. The Keystatic admin keeps working: both edit the same files. Part of [Inti](https://github.com/intijs/inti), currently in beta.

```bash
npm install @intijs/core @intijs/adapter-keystatic
```

```ts
import { KeystaticAdapter } from '@intijs/adapter-keystatic';

const adapter = new KeystaticAdapter({ collection: 'content/pages/*', blocksField: 'blocks' });
const page = await adapter.fetchPageBySlug('home');
```

A page is an entry with a `fields.blocks` field. In production, set `INTI_KEYSTATIC_REPO` and `INTI_KEYSTATIC_TOKEN`: each edit becomes a GitHub commit, and a conflicting change is rejected instead of overwritten.

Keystatic has no write API, so this adapter writes its files directly, and its tests read every write back with the official reader. Rewriting a YAML file keeps the data but not comments or style.

See the [guide](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/adapters/keystatic.mdx).

MIT
