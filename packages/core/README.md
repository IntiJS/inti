# @intijs/core

> **The visual editing layer for headless WordPress on Astro.** Content stays in your CMS; editors change it by double-clicking on the rendered page.

[![npm version](https://img.shields.io/npm/v/@intijs/core.svg)](https://www.npmjs.com/package/@intijs/core)
[![Astro](https://img.shields.io/badge/Astro-5%20%7C%206%20%7C%207-BC52EE?logo=astro)](https://astro.build)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **AI for any CMS, without changing the CMS** — for sites built with Astro. Inti is not a plugin you install inside your CMS: it renders your site with Astro and saves edits back to the CMS you already have.

> **Beta.** Inti is at 0.1: it works and is ready to try, and its APIs may still change before 1.0.

---

## ✨ Features

- 🔌 **Universal CMS Adapter** - Connect WordPress, Kitsuden, Strapi, Contentful, Sanity, or any headless CMS
- ✅ **ValidatedBlocks** - Math validation engine for business-logic blocks
- 📝 **Smart Forms** - Schema-driven forms with spam protection
- 🎨 **Visual Bridge** - In-site editing overlay for any CMS
- ⚡ **Real-time Collaboration** - Live cursors, presence, optimistic updates
- 🚀 **Zero-JS by Default** - Only hydrate interactive blocks

---

## 📦 Installation

### Automatic (Recommended)

```bash
npx astro add inti
```

### Manual

```bash
npm install @intijs/core
```

Then add to `astro.config.mjs`:

```ts
import { defineConfig } from 'astro/config';
import inti from '@intijs/core';

export default defineConfig({
  integrations: [inti()]
});
```

---

## 🚀 Quick Start

### 1. Configure your CMS

Create `inti.config.ts`:

```ts
import { defineConfig } from '@intijs/core';
import { StrapiAdapter } from '@intijs/adapter-strapi';

export default defineConfig({
  adapter: new StrapiAdapter({
    endpoint: 'https://api.example.com',
    apiToken: process.env.STRAPI_TOKEN
  })
});
```

### 2. Fetch content in your page

```astro
---
// src/pages/[slug].astro
import { ContentAdapter } from '@intijs/core';

const adapter = new ContentAdapter();
const page = await adapter.fetchPage(Astro.params.slug);
---

<article>
  <h1>{page.title}</h1>
  {page.blocks.map(block => (
    <div data-inti-block={block.id}>
      {block.rendered}
    </div>
  ))}
</article>
```

### 3. Enable Visual Editing (Dev Only)

```ts
// astro.config.mjs
export default defineConfig({
  integrations: [
    inti({
      visualBridge: true  // Shows edit overlay in dev
    })
  ]
});
```

Hover over any block to edit directly in your CMS!

---

## 🧩 ValidatedBlocks Example

```ts
import { ValidationEngine } from '@intijs/core';

const engine = new ValidationEngine();

const result = await engine.validateBlock({
  fields: [
    { name: 'price', type: 'number', value: 100 },
    { name: 'discount', type: 'number', value: 20 }
  ],
  rules: [
    {
      type: 'math',
      expression: 'discount < price * 0.5',
      message: 'Discount cannot exceed 50%'
    }
  ]
}, data);

if (!result.valid) {
  console.log(result.errors); // [{ field: null, message: '...' }]
}
```

---

## 📋 Smart Forms Example

```astro
---
import { FormEngine } from '@intijs/core';

const formEngine = new FormEngine();
---

<form 
  data-inti-form
  action="/api/submit"
  method="POST"
>
  <input name="email" type="email" required />
  <input name="honeypot" style="display:none" /> <!-- Anti-spam -->
  <button type="submit">Submit</button>
</form>

<script>
  import { FormEngine } from '@intijs/core';
  const engine = new FormEngine();
  engine.attachTo(document.querySelector('[data-inti-form]'));
</script>
```

---

## 🏝️ Interactive components

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

---

## ⚡ Real-time Collaboration

```ts
import { initRealtime } from '@intijs/core';

const realtime = initRealtime({
  roomId: 'page-home',
  userId: 'user-123',
  userName: 'John Doe'
});

// Listen for live updates
realtime.on('update', (event) => {
  console.log(`${event.userName} updated content`);
});

// Show presence
realtime.on('presence', (users) => {
  console.log(`${users.length} users editing`);
});
```

---

## 🔌 Supported CMS

| CMS | Package | Visual Bridge | Real-time |
|-----|---------|---------------|-----------|
| WordPress | `@intijs/adapter-wordpress` | ✅ | ✅ |
| Kitsuden | `@intijs/adapter-kitsuden` | ✅ | ✅ |
| Strapi | `@intijs/adapter-strapi` | ✅ | ✅ |
| Contentful | `@intijs/adapter-contentful` | ✅ | ⚡ |
| Sanity | `@intijs/adapter-sanity` | ✅ | ⚡ |
| Custom | `@intijs/core` | ✅ | ⚡ |

---

## 📚 Documentation

- [Getting Started](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/quickstart.mdx)
- [Adapters](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/adapters/contract.mdx)
- [Securing writes](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/securing-writes.md)
- [Deployment](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/deployment.md)

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](https://github.com/intijs/inti/blob/main/CONTRIBUTING.md).

---

## 📄 License

MIT © [Inti](https://github.com/intijs/inti)
