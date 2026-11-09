# @intijs/adapter-contentful

Read adapter for [Contentful](https://www.contentful.com), part of [Inti](https://github.com/intijs/inti), currently in beta. It converts entries into Inti pages and describes the schema for `inti sync`. **It does not write**, so inline editing is not available.

```bash
npm install @intijs/core @intijs/adapter-contentful
```

```ts
import { ContentfulAdapter } from '@intijs/adapter-contentful';

const adapter = new ContentfulAdapter({
  spaceId: import.meta.env.CONTENTFUL_SPACE_ID,
  accessToken: import.meta.env.CONTENTFUL_TOKEN
});

const page = adapter.parsePage(entry);
```

MIT
