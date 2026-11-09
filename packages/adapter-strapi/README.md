# @intijs/adapter-strapi

Edit [Strapi](https://strapi.io) v4 and v5 content by double-clicking the rendered page. Part of [Inti](https://github.com/intijs/inti), currently in beta.

```bash
npm install @intijs/core @intijs/adapter-strapi
```

```ts
import { StrapiAdapter } from '@intijs/adapter-strapi';

const adapter = new StrapiAdapter({ endpoint: 'https://strapi.example.com' });
const page = await adapter.fetchPageBySlug('home');
```

```bash
# .env — server only, never PUBLIC_
INTI_ADAPTER=strapi
INTI_STRAPI_ENDPOINT=https://strapi.example.com
INTI_STRAPI_TOKEN=                  # an API token with update permission
INTI_STRAPI_CONTENT_TYPE=pages      # pluralApiId of your pages
INTI_STRAPI_BLOCKS_FIELD=blocks     # the dynamic zone
```

A page is an entry with a dynamic zone. The block type is the last part of the component uid: `sections.hero` renders with `src/blocks/Hero.astro`. Writes go through the Strapi API; SEO is read from the `seo` component.

MIT
