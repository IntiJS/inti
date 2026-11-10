# @intijs/genui

A model composes page sections from the blocks you declared. It picks components and fills their fields. It generates no HTML, CSS or code, and everything it returns is validated in shape and in content before use.

> **Not on npm yet.** The `@intijs` packages will be published there. Until then the `npm install` command below answers 404: install from git as described under [Installation](https://github.com/intijs/inti#-installation) in the repository README.

The result is the same JSON a human editor saves, rendered by the same `BlockRenderer`, and saved to whatever CMS the site uses. It runs on an Astro site, not inside the CMS. Part of [Inti](https://github.com/intijs/inti), currently in beta.

```bash
npm install @intijs/genui
```

## Declare the vocabulary

```ts
import { defineVocabulary, fromData } from '@intijs/genui';

export const vocabulary = defineVocabulary({
  ProductGrid: {
    description: 'Compare several products',
    when: 'Only with two or more products',
    fields: {
      heading: { type: 'string', maxLength: 60 },
      body: { type: 'richtext' },
      cta: { type: 'object', fields: { label: { type: 'string' }, url: { type: 'url' } } },
      products: fromData('products', { max: 6 })
    },
    variants: { layout: ['grid', 'list'] }
  }
});
```

Field types: `string`, `text`, `richtext`, `number`, `boolean`, `url`, `list`, `object`, and the references `media`, `relation` and `data`.

**References are the point.** The model only chooses an id from the items you provide; the server fills in the value. A price cannot come from the model:

```ts
import { wooProductsAsData } from '@intijs/adapter-wordpress';

const sources = { products: wooProductsAsData(wooProducts) };
```

## In the editor: propose, preview, accept

```ts
// src/middleware.ts
import { registerIntiPlugin } from '@intijs/core/plugins';
import { createBlockGenerator } from '@intijs/genui';
import { createAnthropicProvider } from '@intijs/genui/anthropic';

const provider = createAnthropicProvider({ apiKey: import.meta.env.ANTHROPIC_API_KEY });

registerIntiPlugin({
  name: 'genui',
  getBlockGenerator: () => createBlockGenerator({ provider, sources })
});
```

The editor's composer gets a ✨ tab. The proposal appears on the page block by block, with your real components. Nothing reaches the CMS until the editor accepts it.

`createAnthropicProvider` turns on server-side refusal fallbacks. Any object implementing `AiProvider` works instead.

## During a visit

```astro
---
// src/pages/search.astro — returns HTML to insert in the page
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import { createVisitorComposer, VISITOR_HEADERS } from '@intijs/genui';

export const partial = true;

const composer = createVisitorComposer({ provider, vocabulary, sources });
const { blocks } = await composer.compose(Astro.url.searchParams.get('q') ?? '', {
  visitorKey: Astro.clientAddress
});

for (const [name, value] of Object.entries(VISITOR_HEADERS)) Astro.response.headers.set(name, value);
---
<BlockRenderer blocks={blocks.map((b) => ({ type: b.nativeType, data: b.data }))} editable={false} />
```

- **It cannot write.** It receives no adapter, so a prompt injection has no tool that reaches the CMS.
- **It cannot spend without limit.** Per-visitor and per-day limits, a block cap and a cache. Tune them with `limits`.
- **It cannot break the page.** Any failure returns no blocks and a status.
- **It is not indexed.** `VISITOR_HEADERS` marks the response `noindex` and `private`. What matters for SEO is generated in the editor and saved in the CMS.

The limits are per process. With several instances, pass `limiter` and `cache` to share them; `@intijs/cloudflare` has both.

## Streaming into the page, with no client JavaScript

Astro renders async iterables in templates, so the HTML leaves as the model finishes each block:

```astro
---
const events = composeStream({ prompt, vocabulary, provider, sources });
---
<h1>Results</h1>
{(async function* () {
  for await (const event of events) {
    if (event.type !== 'block') continue;
    yield <BlockRenderer blocks={[{ type: event.rendered.nativeType, data: event.rendered.data }]} editable={false} />;
  }
})()}
```

The markup after the generator waits for it, in order. To keep the page from waiting, put it in a [server island](https://docs.astro.build/en/guides/server-islands/).

## From other agents

```ts
import { jsonSchema, streamText } from 'ai';
import { createVocabularyTool } from '@intijs/genui';

const compose = await createVocabularyTool(vocabulary, { jsonSchema, sources });
streamText({ model, tools: { compose }, prompt });
```

The tool validates what the agent passes. `@intijs/mcp` does the same with `INTI_MCP_VOCABULARY` pointing at a JSON file.

## A model as a personalization decider

```ts
import { createAiDecider } from '@intijs/genui/decider';

registerIntiPlugin({ name: 'ai', getDeciders: () => [createAiDecider({ provider })] });
```

It only chooses between versions a person already wrote. If it fails, is slow or does not decide, the page shows what it would show without it. See "Personalization" in the docs.
