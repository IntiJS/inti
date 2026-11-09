# @intijs/adapter-sanity

Read adapter for [Sanity](https://www.sanity.io), part of [Inti](https://github.com/intijs/inti), currently in beta. It converts documents into Inti pages and describes the schema for `inti sync`. **It does not write**, so inline editing is not available.

```bash
npm install @intijs/core @intijs/adapter-sanity
```

```ts
import { SanityAdapter } from '@intijs/adapter-sanity';

const adapter = new SanityAdapter({
  projectId: import.meta.env.SANITY_PROJECT_ID,
  dataset: 'production'
});

const page = adapter.parsePage(document);
```

MIT
