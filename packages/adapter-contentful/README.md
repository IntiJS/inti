# @intijs/adapter-contentful

Read adapter for [Contentful](https://www.contentful.com), part of [Inti](https://github.com/intijs/inti), currently in beta. It converts entries into Inti pages and describes the schema for `inti sync`. **It does not write**, so inline editing is not available.

> **Not on npm yet.** The `@intijs` packages will be published there. Until then the `npm install` command below answers 404: install from git as described under [Installation](https://github.com/intijs/inti#-installation) in the repository README.

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
