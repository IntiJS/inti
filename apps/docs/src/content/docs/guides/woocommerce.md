---
title: WooCommerce
description: Render a Woo store fast and with product rich results
---

Inti is the editing layer on top of the CMS. A WooCommerce product **is not edited visually** —its schema is fixed, not a composition of blocks— so it is still managed in wp-admin.

What Inti does bring to a Woo store is two things: **content pages** (home, landing pages, blog) the client can edit, and the **product JSON-LD** that gets Google to show price and availability in the search result.

## What it covers and what it does not

| | |
|---|---|
| Home, landing pages, blog | ✅ Full visual editing |
| Product page | ✅ Rendering + rich results, ❌ no inline editing |
| Cart and checkout | ❌ Stays in WordPress |

## Products do not go through the adapter

The adapter contract exists for the editing layer. Rendering a product does not need it: `wc/v3` is queried directly from the Astro page.

```astro
---
// src/pages/product/[slug].astro
import { buildProductSchema, serializeJsonLd } from '@intijs/core/seo';
import { productFromWooCommerce } from '@intijs/adapter-wordpress';

const { slug } = Astro.params;

const auth = btoa(`${import.meta.env.WC_KEY}:${import.meta.env.WC_SECRET}`);
const res = await fetch(
  `${import.meta.env.WC_ENDPOINT}/wp-json/wc/v3/products?slug=${slug}`,
  { headers: { Authorization: `Basic ${auth}` } }
);
const [raw] = await res.json();

const product = productFromWooCommerce(raw, { currency: 'EUR' });
const jsonLd = buildProductSchema(product);
---

<script type="application/ld+json" set:html={serializeJsonLd(jsonLd)} />

<h1>{product.name}</h1>
```

The `wc/v3` credentials are a consumer key and secret, different from the Application Password the pages adapter uses. Both go without the `PUBLIC_` prefix.

## You have to pass the currency

WooCommerce **does not include the currency** in the product response: it is a store setting. And Google requires it for the rich result.

Query it once and set it in the environment:

```bash
curl -u "key:secret" https://shop.com/wp-json/wc/v3/data/currencies/current
```

If you forget it, `auditProductSchema` says so:

```ts
import { auditProductSchema } from '@intijs/core/seo';

const problems = auditProductSchema(product, { currency: 'EUR' });
if (problems.length) console.warn(problems.join('\n'));
```

## Products with variations

A `variable` product returns its **minimum** price in `price`. That is already valid, but if you want Google to show a range ("from €19.99"), pass it the variations:

```ts
const variations = await fetch(
  `${WC}/wp-json/wc/v3/products/${raw.id}/variations`,
  { headers: { Authorization: `Basic ${auth}` } }
).then((r) => r.json());

const product = productFromWooCommerce(raw, { currency: 'EUR', variations });
```

With more than one distinct price an `AggregateOffer` with `lowPrice` and `highPrice` is emitted. If all variations cost the same, a simple `Offer` is emitted — a range from 19.99 to 19.99 is noise.

## Price and stock cannot be cached

This is the architecture decision that matters most.

If you generate the product page statically, everything heavy (images, description, attributes) is served instantly. But **price and availability expire**, and announcing "In stock" on a sold-out product is worse than being slow: Google flags the page as having incorrect structured data.

Three ways out, from least to most work:

1. **SSR for the product page.** Simple and always correct. You lose part of the speed advantage.
2. **Static + stock island.** The page is static and a small component queries price and availability live. It is the best compromise.
3. **Rebuild by webhook.** WooCommerce fires `product.updated` and you regenerate that product page. Fast and correct, but you need incremental builds.

With option 2, remember that the JSON-LD is generated at build time: if stock changes, the structured data falls out of date even though the island shows the right thing. For catalogs with volatile stock, option 1 or 3.

## Do not index everything the API returns

WooCommerce serves products hidden from the catalog and drafts through the API. Filter before putting them in the sitemap:

```ts
import { isIndexableProduct } from '@intijs/adapter-wordpress';

const indexable = allProducts.filter(isIndexableProduct);
```

## Fields that improve the result

All optional, but each one adds information to the rich result:

| Field | Source in WooCommerce |
|---|---|
| `sku` | `sku` |
| `gtin` | `global_unique_id` (native since WC 9.2) |
| `brand` | `brands[0].name` (native since WC 9.4) |
| `aggregateRating` | `average_rating` + `rating_count` |

If the store does not use the brands taxonomy, pass `brand` in the mapping options.
