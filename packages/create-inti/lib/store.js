/**
 * The files of a store: pages from the local store, products from Odoo, and the interactive
 * parts as Svelte islands built with tallao.
 *
 * Only what has to react runs in the browser: the gallery, the variant picker and quantity, and
 * the cart. The product page, the category page, prices and stock are rendered on the server,
 * so a crawler and a visitor without JavaScript see the same product.
 */

/** Dependencies a store adds to the project */
export const STORE_DEPENDENCIES = {
    '@astrojs/svelte': '^9.1.0',
    svelte: '^5.43.6',
    // Not on npm: installed from its repository (its `prepare` builds it)
    tallao: 'github:tallao-ui/tallao'
};

export const STORE_ASTRO_CONFIG = `import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import svelte from '@astrojs/svelte';
import inti from '@intijs/core';

export default defineConfig({
    // Prices and stock are read from Odoo on each request (behind a cache)
    output: 'server',
    // Without an Astro adapter the actions (edits and orders) do not exist
    adapter: node({ mode: 'standalone' }),
    // Svelte for the islands: gallery, variant picker, cart
    integrations: [inti(), svelte()]
});
`;

export const STORE_CATALOG = `import { createOdooClient, envKeyStore, odooCatalogSource } from '@intijs/adapter-odoo';
import { createCacheManager } from '@intijs/core/cache';
import { cachedCatalogSource, createCatalog } from '@intijs/core/catalog';
import { env } from '@intijs/core/server';

/**
 * The connection to Odoo. JSON-2 on Odoo 19+, JSON-RPC (with INTI_ODOO_LOGIN) on older ones.
 * The key store reads INTI_ODOO_API_KEY and, during a rotation, INTI_ODOO_API_KEY_NEXT.
 */
export const odoo = createOdooClient({
    url: env('INTI_ODOO_URL') ?? '',
    database: env('INTI_ODOO_DATABASE'),
    apiKey: envKeyStore(env),
    login: env('INTI_ODOO_LOGIN')
});

/** One cache for pages, products and HTML. With several instances, give it a Valkey provider */
export const cache = createCacheManager({ defaultTtl: 60, swr: 300, staleIfError: 86400 });

/** Products from Odoo, cached by item and listing; an Odoo webhook purges what changed */
export const products = cachedCatalogSource(
    odooCatalogSource({ client: odoo, taxes: env('INTI_ODOO_PRICES') === 'excluded' ? 'excluded' : 'included' }),
    { cache, itemTtl: 60, listTtl: 30 }
);

export const catalog = createCatalog([products]);

/** \`19.9\` in the visitor's language and the product's currency */
export function money(amount: number | string | undefined, currency = 'EUR', locale = 'en'): string {
    if (amount === undefined) return '';
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(amount));
}
`;

export const STORE_MIDDLEWARE_DELIVERY = `
import { intiDelivery } from '@intijs/core/delivery';
import { cache } from './lib/catalog';

// Anonymous visitors get the cached HTML and CDN headers; editors get private
// responses with the editing markup. A page that shows a product tags its HTML
// with it, so Odoo's purge notice also refreshes that page.
export const onRequest = intiDelivery({ cache });
`;

export const STORE_ACTIONS = `import { defineAction } from 'astro:actions';
import { z } from 'astro:schema';
import { intiActions } from '@intijs/core/actions';
import { createOdooOrder } from '@intijs/adapter-odoo';
import { odoo } from '../lib/catalog';

export const server = {
    // Inline editing of the pages
    inti: intiActions,

    /**
     * A quotation in Odoo from the cart. Only references and quantities travel: Odoo prices
     * the order. It is public: put a rate limit and a bot check in front of it.
     */
    order: defineAction({
        input: z.object({
            customer: z.object({
                email: z.string().email().max(254),
                name: z.string().min(1).max(200),
                phone: z.string().max(40).optional()
            }),
            lines: z.array(z.object({ reference: z.string().min(1).max(100), quantity: z.number().int().min(1).max(999) })).min(1).max(50),
            note: z.string().max(2000).optional()
        }),
        handler: (input) => createOdooOrder(odoo, input)
    })
};
`;

export const STORE_PRODUCT_PAGE = `---
import Layout from '../../layouts/Layout.astro';
import ProductGallery from '../../components/ProductGallery.svelte';
import BuyBox from '../../components/BuyBox.svelte';
import CartSheet from '../../components/CartSheet.svelte';
import { readItem, itemCacheTags, catalogItemToProduct } from '@intijs/core/catalog';
import { buildProductSchema } from '@intijs/core/seo';
import { pageErrorResponse } from '@intijs/core/server';
import { products, money } from '../../lib/catalog';

let item;
try {
    item = await readItem(products, Astro.params.slug ?? '');
} catch (error) {
    // 404 when Odoo has no such product (or does not publish it), 503 when it cannot answer
    return pageErrorResponse(error);
}

// The name changed: one address per product
if (item.slug !== Astro.params.slug) return Astro.redirect(\`/products/\${item.slug}\`, 301);

// A price or stock notice from Odoo for this product also purges this page's HTML
Astro.locals.intiCacheTags = itemCacheTags('odoo', item);

const currency = item.price?.currency ?? 'EUR';
const schema = buildProductSchema(catalogItemToProduct(item, { url: Astro.url.href }), { currency });
const page = { id: item.id, slug: item.slug, title: item.title, blocks: [], seo: { title: item.title, description: item.description, image: item.images?.[0] } };
const variants = (item.variants ?? []).map((variant) => ({
    reference: variant.sku ?? variant.id,
    options: variant.options,
    price: Number(variant.price?.amount ?? item.price?.amount ?? 0),
    available: variant.availability !== 'OutOfStock'
}));
---

<Layout page={page}>
    <script type="application/ld+json" set:html={JSON.stringify(schema).replace(/</g, '\\\\u003c')} />
    <main class="product">
        <ProductGallery client:visible images={item.images ?? []} alt={item.title} />
        <section>
            <h1>{item.title}</h1>
            <p class="price">
                {money(item.price?.amount, currency)}
                {item.price?.compareAt && <s>{money(item.price.compareAt, currency)}</s>}
            </p>
            {item.description && <div class="description" set:html={item.description} />}
            <BuyBox
                client:load
                title={item.title}
                currency={currency}
                reference={item.sku ?? item.id}
                price={Number(item.price?.amount ?? 0)}
                available={item.availability !== 'OutOfStock'}
                quantity={item.quantity}
                variants={variants}
            />
        </section>
    </main>
    <CartSheet client:idle currency={currency} />
</Layout>

<style>
    .product { display: grid; gap: 2rem; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); max-width: 72rem; margin: 2rem auto; padding: 0 1rem; }
    .price { font-size: 1.5rem; font-weight: 600; }
    .price s { font-weight: 400; opacity: 0.6; margin-left: 0.5rem; }
</style>
`;

export const STORE_CATEGORY_PAGE = `---
import Layout from '../../layouts/Layout.astro';
import CartSheet from '../../components/CartSheet.svelte';
import { readCollection } from '@intijs/core/catalog';
import { pageErrorResponse } from '@intijs/core/server';
import { products, money } from '../../lib/catalog';

const pageNumber = Math.max(1, Number(Astro.url.searchParams.get('page')) || 1);
const sort = Astro.url.searchParams.get('sort') ?? undefined;
const inStock = Astro.url.searchParams.get('stock') === '1';

let result;
try {
    result = await readCollection(products, Astro.params.slug ?? '', { page: pageNumber, pageSize: 24, sort: sort as any, inStock });
} catch (error) {
    return pageErrorResponse(error);
}

// The listing is tagged: a change notice from Odoo drops it
Astro.locals.intiCacheTags = ['catalog:odoo:lists'];

const { collection, page } = result;
const pages = Math.ceil(page.total / page.pageSize);
const link = (n: number) => \`?page=\${n}\${sort ? \`&sort=\${sort}\` : ''}\${inStock ? '&stock=1' : ''}\`;
const seo = { id: collection.id, slug: collection.slug, title: collection.title, blocks: [], seo: { title: collection.title } };
---

<Layout page={seo}>
    <main class="category">
        <h1>{collection.title}</h1>
        <nav class="filters">
            <a href="?sort=price-asc">Price ↑</a> · <a href="?sort=price-desc">Price ↓</a> · <a href="?sort=newest">Newest</a> ·
            <a href={inStock ? '?' : '?stock=1'}>{inStock ? 'All products' : 'In stock only'}</a>
        </nav>
        <ul class="grid">
            {page.items.map((item) => (
                <li>
                    <a href={\`/products/\${item.slug}\`}>
                        {item.images?.[0] && <img src={item.images[0]} alt={item.title} width="512" height="512" loading="lazy" />}
                        <strong>{item.title}</strong>
                        <span>{money(item.price?.amount, item.price?.currency)}</span>
                        {item.availability === 'OutOfStock' && <em>Out of stock</em>}
                    </a>
                </li>
            ))}
        </ul>
        {pages > 1 && (
            <nav class="pages" aria-label="Pages">
                {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (n === page.page ? <span aria-current="page">{n}</span> : <a href={link(n)}>{n}</a>))}
            </nav>
        )}
    </main>
    <CartSheet client:idle />
</Layout>

<style>
    .category { max-width: 72rem; margin: 2rem auto; padding: 0 1rem; }
    .grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); list-style: none; padding: 0; }
    .grid a { display: grid; gap: 0.25rem; color: inherit; text-decoration: none; }
    .grid img { width: 100%; height: auto; aspect-ratio: 1; object-fit: cover; }
    .pages { display: flex; gap: 0.5rem; margin-top: 2rem; }
</style>
`;

export const STORE_GALLERY = `<script lang="ts">
    // The product's photos, swiped on a phone and arrowed on a desktop
    import { Carousel } from 'tallao';
    import 'tallao/tokens.css';

    let { images = [], alt = '' }: { images: string[]; alt: string } = $props();
</script>

<Carousel items={images} slideWidth="100%" label={alt} slideLabel={(n, total) => \`\${n} of \${total}\`}>
    {#snippet slide(src, index)}
        <img {src} alt={index === 0 ? alt : ''} width="1024" height="1024" loading={index === 0 ? 'eager' : 'lazy'} style="width:100%;height:auto;aspect-ratio:1;object-fit:contain" />
    {/snippet}
</Carousel>
`;

export const STORE_CART = `/**
 * The cart, in this browser. Every island reads and writes it here, and hears about changes
 * through one event, so the buy box and the cart sheet never disagree.
 */

export interface CartLine {
    reference: string;
    title: string;
    price: number;
    quantity: number;
}

const KEY = 'inti-cart';
const EVENT = 'inti-cart';

export function readCart(): CartLine[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function writeCart(lines: CartLine[]): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(lines));
    } catch {
        // private mode: the cart lives until the page closes
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: lines }));
}

export function addToCart(line: CartLine): void {
    const lines = readCart();
    const existing = lines.find((candidate) => candidate.reference === line.reference);
    if (existing) existing.quantity = Math.min(999, existing.quantity + line.quantity);
    else lines.push(line);
    writeCart(lines);
}

export function onCartChange(listener: (lines: CartLine[]) => void): () => void {
    const handler = (event: Event) => listener((event as CustomEvent<CartLine[]>).detail);
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
}

export function openCart(): void {
    window.dispatchEvent(new CustomEvent('inti-cart-open'));
}
`;

export const STORE_BUYBOX = `<script lang="ts">
    // Variant, quantity, add to cart. The price shown is the server's; the order is priced by Odoo
    import { Badge, Button, NumberInput, ToggleGroup, toast } from 'tallao';
    import 'tallao/tokens.css';
    import { addToCart, openCart } from '../lib/cart';

    interface Variant { reference: string; options: Record<string, string>; price: number; available: boolean }
    let {
        title,
        reference,
        price,
        currency = 'EUR',
        available = true,
        quantity: stock,
        variants = []
    }: { title: string; reference: string; price: number; currency?: string; available?: boolean; quantity?: number; variants?: Variant[] } = $props();

    // One group of buttons per option (Size, Color), from the variants Odoo has
    const attributes = $derived(
        [...new Set(variants.flatMap((variant) => Object.keys(variant.options)))].map((name) => ({
            name,
            values: [...new Set(variants.map((variant) => variant.options[name]).filter(Boolean))]
        }))
    );
    let chosen = $state<Record<string, string>>({});
    let amount = $state(1);

    const variant = $derived(
        variants.length ? variants.find((candidate) => attributes.every((a) => candidate.options[a.name] === chosen[a.name])) : undefined
    );
    const ready = $derived(variants.length === 0 || Boolean(variant));
    const canBuy = $derived(ready && (variant ? variant.available : available));
    const shownPrice = $derived(variant?.price ?? price);
    const format = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);

    function add() {
        if (!canBuy) return;
        addToCart({ reference: variant?.reference ?? reference, title: variant ? \`\${title} (\${Object.values(variant.options).join(', ')})\` : title, price: shownPrice, quantity: amount });
        toast.success('Added to the cart');
        openCart();
    }
</script>

<div class="buybox">
    {#each attributes as attribute (attribute.name)}
        <ToggleGroup
            label={attribute.name}
            hideLabel={false}
            type="single"
            required
            variant="pills"
            options={attribute.values.map((value) => ({
                value,
                label: value,
                disabled: !variants.some((v) => v.available && v.options[attribute.name] === value)
            }))}
            value={chosen[attribute.name]}
            onchange={(value) => (chosen = { ...chosen, [attribute.name]: value })}
        />
    {/each}

    {#if variants.length}<p class="price">{format(shownPrice)}</p>{/if}

    {#if !canBuy && ready}
        <Badge variant="error" dot>Out of stock</Badge>
    {:else if stock !== undefined && stock > 0 && stock < 5 && !variants.length}
        <Badge variant="warning" dot>Only {stock} left</Badge>
    {/if}

    <NumberInput value={amount} min={1} max={stock ?? 999} stepper clamp ariaLabel="Quantity" onchange={(value) => (amount = value ?? 1)} />
    <Button variant="primary" size="lg" disabled={!canBuy} onclick={add}>
        {ready ? 'Add to cart' : 'Choose an option'}
    </Button>
</div>

<style>
    .buybox { display: grid; gap: 1rem; max-width: 24rem; }
    .price { font-size: 1.25rem; font-weight: 600; }
</style>
`;

export const STORE_CART_SHEET = `<script lang="ts">
    // The cart and the order form. The order goes to the \`order\` action, which asks Odoo for a quotation
    import { onMount } from 'svelte';
    import { actions } from 'astro:actions';
    import { Button, Field, Input, NumberInput, Sheet, Toaster, toast } from 'tallao';
    import 'tallao/tokens.css';
    import { readCart, writeCart, onCartChange, type CartLine } from '../lib/cart';

    let { currency = 'EUR' }: { currency?: string } = $props();
    let lines = $state<CartLine[]>([]);
    let open = $state(false);
    let email = $state('');
    let name = $state('');
    let sending = $state(false);
    let done = $state<string | null>(null);

    const total = $derived(lines.reduce((sum, line) => sum + line.price * line.quantity, 0));
    const format = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);

    onMount(() => {
        lines = readCart();
        const stop = onCartChange((next) => (lines = next));
        const show = () => (open = true);
        window.addEventListener('inti-cart-open', show);
        return () => {
            stop();
            window.removeEventListener('inti-cart-open', show);
        };
    });

    function setQuantity(reference: string, quantity: number | null) {
        writeCart(lines.map((line) => (line.reference === reference ? { ...line, quantity: quantity ?? 1 } : line)).filter((line) => line.quantity > 0));
    }

    async function send(event: SubmitEvent) {
        event.preventDefault();
        sending = true;
        const { data, error } = await actions.order({ customer: { email, name }, lines: lines.map(({ reference, quantity }) => ({ reference, quantity })) });
        sending = false;
        if (error) {
            toast.error(error.message);
            return;
        }
        done = data.name;
        writeCart([]);
    }
</script>

<Toaster position="bottom-center" />
<Button variant="outline" onclick={() => (open = true)} ariaLabel="Open the cart">
    Cart ({lines.reduce((sum, line) => sum + line.quantity, 0)})
</Button>

<Sheet {open} side="right" title="Your cart" onClose={() => (open = false)}>
    {#if done}
        <p>Thank you. Your order <strong>{done}</strong> was received; we will email you to confirm it.</p>
    {:else if lines.length === 0}
        <p>The cart is empty.</p>
    {:else}
        <ul class="lines">
            {#each lines as line (line.reference)}
                <li>
                    <span>{line.title}</span>
                    <NumberInput value={line.quantity} min={0} max={999} stepper size="sm" ariaLabel={\`Quantity of \${line.title}\`} onchange={(value) => setQuantity(line.reference, value)} />
                    <span>{format(line.price * line.quantity)}</span>
                </li>
            {/each}
        </ul>
        <p class="total">Total: {format(total)} <small>(final price confirmed by the shop)</small></p>
        <form onsubmit={send}>
            <Field label="Name" required><Input bind:value={name} /></Field>
            <Field label="Email" required><Input type="email" bind:value={email} /></Field>
            <Button type="submit" variant="primary" loading={sending}>Place the order</Button>
        </form>
    {/if}
</Sheet>

<style>
    .lines { display: grid; gap: 0.75rem; list-style: none; padding: 0; }
    .lines li { display: grid; grid-template-columns: 1fr auto auto; gap: 0.5rem; align-items: center; }
    .total { font-weight: 600; }
    form { display: grid; gap: 0.75rem; margin-top: 1rem; }
</style>
`;

export const STORE_IMAGE_ROUTE = `import { odooImageRoute } from '@intijs/adapter-odoo';
import { odoo } from '../../../../../lib/catalog';

export const prerender = false;
// Product images from the site's own origin; only published products are served
export const GET = odooImageRoute({ client: odoo });
`;

export const STORE_PURGE_ROUTE = `import { odooPurgeRoute } from '@intijs/adapter-odoo';
import { env } from '@intijs/core/server';
import { cache } from '../../../lib/catalog';

export const prerender = false;
// An Odoo automation rule (On update of Product → Send Webhook Notification, with the
// field default_code) posts here: https://your-site/api/odoo/purge?token=…
export const POST = odooPurgeRoute({ cache, token: () => env('INTI_ODOO_PURGE_TOKEN') });
`;

export const STORE_SITEMAP_SECTIONS = `import { sitemapSection, toSitemapEntries } from '@intijs/core/seo';
import { catalogSitemap } from '@intijs/core/catalog';
import { LocalAdapter } from '@intijs/core/adapters/local';
import { products } from './catalog';

export const site = import.meta.env.SITE ?? 'https://www.example.com';

export const sections = [
    sitemapSection('pages', async () => toSitemapEntries(await new LocalAdapter().listPages(), { site })),
    // A file per 50,000 products, read from Odoo a batch at a time
    catalogSitemap(products, { site, name: 'products', pathFor: (item) => \`/products/\${item.slug}\` })
];
`;

export const STORE_SITEMAP_INDEX = `import { sitemapIndexRoute } from '@intijs/core/seo';
import { sections, site } from '../lib/sitemap';

export const prerender = false;
export const GET = sitemapIndexRoute({ site, sections });
`;

export const STORE_SITEMAP_FILE = `import { sitemapFileRoute } from '@intijs/core/seo';
import { sections, site } from '../lib/sitemap';

export const prerender = false;
export const GET = sitemapFileRoute({ site, sections });
`;

export const STORE_ENV = `
# Odoo: products, prices, stock and orders
INTI_ODOO_URL=https://erp.yoursite.com
INTI_ODOO_DATABASE=
# An API key of a user that can read products and create quotations (Preferences → Account
# Security → New API Key). Keys expire (90 days at most for most groups): set the next one
# here before the current one expires, then make it the current one.
INTI_ODOO_API_KEY=
# INTI_ODOO_API_KEY_NEXT=
# INTI_ODOO_API_KEY_EXPIRES=2027-02-18
# Odoo 18 or older (no JSON-2): the login of the key's user
# INTI_ODOO_LOGIN=
# Prices shown with taxes (included, default) or without (excluded)
# INTI_ODOO_PRICES=included
# Token in the URL Odoo's webhook posts to (/api/odoo/purge?token=…)
INTI_ODOO_PURGE_TOKEN=
`;

/** The store's files, besides the project's own */
export function storeFiles() {
    return {
        'src/lib/catalog.ts': STORE_CATALOG,
        'src/lib/cart.ts': STORE_CART,
        'src/lib/sitemap.ts': STORE_SITEMAP_SECTIONS,
        'src/actions/index.ts': STORE_ACTIONS,
        'src/pages/products/[slug].astro': STORE_PRODUCT_PAGE,
        'src/pages/categories/[slug].astro': STORE_CATEGORY_PAGE,
        'src/pages/media/odoo/[model]/[id]/[size].ts': STORE_IMAGE_ROUTE,
        'src/pages/api/odoo/purge.ts': STORE_PURGE_ROUTE,
        'src/pages/sitemap.xml.ts': STORE_SITEMAP_INDEX,
        'src/pages/sitemap-[section]-[file].xml.ts': STORE_SITEMAP_FILE,
        'src/components/ProductGallery.svelte': STORE_GALLERY,
        'src/components/BuyBox.svelte': STORE_BUYBOX,
        'src/components/CartSheet.svelte': STORE_CART_SHEET
    };
}
