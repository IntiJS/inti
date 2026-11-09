# Inti.js Core - Usage Guide

## 🖼️ Image Component

### Setup
```typescript
// astro.config.mjs
import { configureImageService } from '@intijs/core/image';

configureImageService({
    endpoint: 'https://api.example.com',
    cdnUrl: 'https://cdn.example.com'
});
```

### Usage
```astro
---
import { IntiImage } from '@intijs/core/astro';
import type { MediaAsset } from '@intijs/core';

const asset: MediaAsset = {
    id: 'image-123',
    url: 'https://cdn.example.com/image.jpg',
    alt: 'Description',
    width: 1200,
    height: 800
};
---

<!-- Basic usage -->
<IntiImage src={asset} alt="My Image" width={600} />

<!-- Responsive images -->
<IntiImage 
    src={asset} 
    responsive 
    sizes="(max-width: 768px) 100vw, 50vw"
    breakpoints={[320, 640, 960, 1280]}
/>

<!-- With priority (above the fold) -->
<IntiImage src={asset} priority format="webp" quality={90} />
```

## 🔄 Transformers

### Markdown
```typescript
import { MarkdownTransformer, transformContent } from '@intijs/core';

const transformer = new MarkdownTransformer({
    gfm: true,
    breaks: false
});

const result = await transformContent(markdownString, 'markdown', {
    fieldPath: 'content.body'
});

console.log(result.html);        // HTML output
console.log(result.toc);         // Table of contents
console.log(result.metadata.readingTime); // Estimated reading time
```

### MDX
```typescript
import { MDXTransformer } from '@intijs/core';

const transformer = new MDXTransformer({
    remarkPlugins: [],
    rehypePlugins: []
});

const result = await transformer.transform(mdxContent, {
    contentType: 'mdx',
    fieldPath: 'content.mdx'
});

console.log(result.frontmatter); // Frontmatter data
console.log(result.html);        // Rendered HTML
```

### Rich Text (Portable Text / ProseMirror)
```typescript
import { RichTextTransformer } from '@intijs/core';

const transformer = new RichTextTransformer();

// Works with Strapi, Sanity, Contentful rich text formats
const result = await transformer.transform(richTextDocument, {
    contentType: 'rich-text',
    fieldPath: 'content.richText'
});

console.log(result.headings);    // Extracted headings
console.log(result.html);        // Rendered HTML
```

## 👁️ Live Preview

### Server Setup (CLI)
```typescript
// inti.config.ts
import { defineConfig } from '@intijs/core';

export default defineConfig({
    adapter: 'wordpress',
    adapterConfig: { /* ... */ },
    preview: {
        enabled: true,
        wsPort: 3001,
        draftMode: true,
        cmsToken: process.env.CMS_PREVIEW_TOKEN
    }
});
```

### Astro Integration
```astro
---
import { usePreviewMode, getPreviewScript } from '@intijs/core/preview';

const preview = usePreviewMode(Astro.request);
const isDraft = preview.isPreview;

// Fetch draft content if in preview mode
const page = await fetchPage({
    slug: Astro.params.slug,
    draft: isDraft,
    token: preview.draftToken
});
---

<!-- Inject preview script -->
<Fragment set:html={getPreviewScript({
    enabled: true,
    wsPort: 3001
})} />
```

### Browser Client
```typescript
import { initPreview } from '@intijs/core/preview';

// Auto-connects when ?preview=1 is in URL
const client = initPreview({
    enabled: true,
    wsPort: 3001,
    draftMode: true
}, {
    onUpdate: (message) => {
        console.log('Content updated:', message);
        // Page will auto-reload
    }
});

// Check if in preview mode
if (client.isPreviewMode()) {
    console.log('Viewing draft content');
}
```

## 🔌 Adapter Configuration

### Strapi
```typescript
import { StrapiAdapter } from '@intijs/adapter-strapi';

const adapter = new StrapiAdapter({
    endpoint: 'https://api.strapi.io',
    apiToken: process.env.STRAPI_TOKEN,
    populate: '*',
    draftMode: true
});
```

### Contentful
```typescript
import { ContentfulAdapter } from '@intijs/adapter-contentful';

const adapter = new ContentfulAdapter({
    spaceId: 'abc123',
    accessToken: process.env.CONTENTFUL_TOKEN,
    previewToken: process.env.CONTENTFUL_PREVIEW_TOKEN,
    draftMode: false
});
```

### Sanity
```typescript
import { SanityAdapter } from '@intijs/adapter-sanity';

const adapter = new SanityAdapter({
    projectId: 'abc123',
    dataset: 'production',
    token: process.env.SANITY_TOKEN,
    perspective: 'published',
    draftMode: false
});
```

## 📦 Full Example

```astro
---
// src/pages/[...slug].astro
import { BlockRenderer, IntiImage } from '@intijs/core/astro';
import { transformContent, usePreviewMode } from '@intijs/core';
import { getPage } from '../lib/inti-sdk';

const { slug } = Astro.params;
const preview = usePreviewMode(Astro.request);

// Fetch page with preview support
const page = await getPage(slug, {
    draft: preview.isPreview,
    token: preview.draftToken
});

// Transform rich text blocks
for (const block of page.blocks) {
    if (block.type === 'rich-text') {
        const result = await transformContent(
            block.data.content, 
            'rich-text'
        );
        block.data.html = result.html;
    }
}
---

<h1>{page.title}</h1>

<BlockRenderer blocks={page.blocks} />

<!-- Preview indicator -->
{preview.isPreview && (
    <div class="preview-banner">
        📝 Preview Mode - Draft Content
    </div>
)}
```
