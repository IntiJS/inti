/**
 * From a WooCommerce product (`wc/v3`) to Inti's `Product` schema.
 *
 * It is only a translator, not an adapter: products are edited in
 * wp-admin and read directly from the Astro page that renders them.
 * The adapter contract exists for the editing layer, and a product is
 * not edited visually —its schema is fixed, not a composition of
 * blocks.
 *
 * The goal is the rich result: Google showing price and "In stock"
 * in the search result. It is a store's biggest SEO lever, above any
 * loading metric.
 */

import type {
    ProductInput,
    ProductOffer,
    ProductAvailability
} from '@intijs/core/seo';

/** Partial shape of the `GET /wp-json/wc/v3/products` response */
export interface WooProduct {
    id?: number;
    name?: string;
    slug?: string;
    permalink?: string;
    description?: string;
    short_description?: string;
    sku?: string;
    /** Native since WooCommerce 9.2; before that a plugin provided it */
    global_unique_id?: string;
    price?: string;
    regular_price?: string;
    sale_price?: string;
    on_sale?: boolean;
    date_on_sale_to?: string | null;
    stock_status?: string;
    stock_quantity?: number | null;
    type?: string;
    status?: string;
    catalog_visibility?: string;
    images?: Array<{ src?: string; alt?: string }>;
    categories?: Array<{ name?: string; slug?: string }>;
    /** Native since WooCommerce 9.4; before that, a brands plugin */
    brands?: Array<{ name?: string }>;
    average_rating?: string;
    rating_count?: number;
    attributes?: Array<{ name?: string; options?: string[] }>;
}

/** A variation from `GET /wp-json/wc/v3/products/<id>/variations` */
export interface WooVariation {
    price?: string;
    regular_price?: string;
    sale_price?: string;
    stock_status?: string;
    sku?: string;
    permalink?: string;
}

export interface WooMappingOptions {
    /**
     * The store's ISO 4217 currency ('EUR', 'USD'…).
     *
     * Google requires it and WooCommerce **does not include it** in the product
     * response: it is a store setting. Query it once at
     * `/wp-json/wc/v3/data/currencies/current` or set it in `.env`.
     */
    currency?: string;
    /**
     * Variations already fetched, for a `variable` product. With them
     * the price range is emitted ("from X"); without them the base
     * price is used, which in WooCommerce is the minimum.
     */
    variations?: WooVariation[];
    /** Default brand if the store does not use the brands taxonomy */
    brand?: string;
    /** Long description instead of the excerpt (default: the excerpt) */
    useFullDescription?: boolean;
}

/**
 * WooCommerce `stock_status` to schema.org `ItemAvailability`.
 *
 * `undefined` is returned for an unknown value instead of assuming
 * availability: announcing "In stock" on a sold-out product makes
 * Google flag the page as having invalid structured data, which
 * is worse than omitting the field.
 */
export function mapStockStatus(status: string | undefined): ProductAvailability | undefined {
    switch (status) {
        case 'instock':
            return 'InStock';
        case 'outofstock':
            return 'OutOfStock';
        case 'onbackorder':
            return 'BackOrder';
        default:
            return undefined;
    }
}

/** Strips tags and basic entities from WooCommerce HTML fields */
function stripHtml(html: string | undefined): string | undefined {
    if (!html) return undefined;
    const text = html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    return text === '' ? undefined : text;
}

function offerFrom(
    source: { price?: string; sale_price?: string; regular_price?: string; stock_status?: string; permalink?: string },
    options: WooMappingOptions,
    saleEndsAt?: string | null
): ProductOffer {
    // `price` already reflects the active sale; the other two are the fallback.
    const price = source.price || source.sale_price || source.regular_price;

    return {
        price,
        currency: options.currency,
        availability: mapStockStatus(source.stock_status),
        url: source.permalink,
        priceValidUntil: saleEndsAt ?? undefined
    };
}

/**
 * Translates a WooCommerce product into the input that
 * `buildProductSchema` expects.
 *
 * @example
 * ```astro
 * ---
 * import { buildProductSchema, serializeJsonLd } from '@intijs/core/seo';
 * import { productFromWooCommerce } from '@intijs/adapter-wordpress';
 *
 * const product = productFromWooCommerce(wcProduct, { currency: 'EUR' });
 * const jsonLd = buildProductSchema(product);
 * ---
 * <script type="application/ld+json" set:html={serializeJsonLd(jsonLd)} />
 * ```
 */
export function productFromWooCommerce(
    raw: WooProduct,
    options: WooMappingOptions = {}
): ProductInput {
    const images = (raw.images ?? [])
        .map((image) => image?.src)
        .filter((src): src is string => typeof src === 'string' && src !== '');

    const description = options.useFullDescription
        ? stripHtml(raw.description) ?? stripHtml(raw.short_description)
        : stripHtml(raw.short_description) ?? stripHtml(raw.description);

    // A variable product without fetched variations only knows its
    // minimum price: it is emitted as a single offer, which is correct even
    // though it shows no range.
    const variations = options.variations ?? [];
    const offers: ProductOffer[] =
        variations.length > 0
            ? variations.map((variation) => offerFrom(variation, options, raw.date_on_sale_to))
            : [offerFrom(raw, options, raw.on_sale ? raw.date_on_sale_to : undefined)];

    const ratingCount = Number(raw.rating_count ?? 0);
    const ratingValue = Number(raw.average_rating ?? 0);

    return {
        name: raw.name ?? '',
        description,
        images,
        url: raw.permalink,
        sku: raw.sku || undefined,
        gtin: raw.global_unique_id || undefined,
        brand: raw.brands?.[0]?.name || options.brand,
        category: raw.categories?.[0]?.name,
        offers,
        rating:
            Number.isFinite(ratingCount) && ratingCount > 0 && ratingValue > 0
                ? { value: ratingValue, count: ratingCount, best: 5, worst: 1 }
                : undefined
    };
}

/**
 * Should this product appear in the sitemap and be indexable?
 *
 * WooCommerce publishes products hidden from the catalog and drafts
 * in the API. Indexing them produces pages that Search Console flags as
 * low-quality content.
 */
export function isIndexableProduct(raw: WooProduct): boolean {
    if (raw.status && raw.status !== 'publish') return false;
    if (raw.catalog_visibility === 'hidden') return false;
    return true;
}

export interface WooDataItem {
    id: number;
    /** The only thing a model sees: no long text from the store, and nothing to redact */
    summary: string;
    value: {
        id: number;
        name: string;
        url?: string;
        price?: string;
        regularPrice?: string;
        onSale: boolean;
        inStock: boolean;
        image?: { src?: string; alt?: string };
    };
}

/**
 * Products as a data source for `@intijs/genui`: a model picks ids and the
 * server sets the price, so the model cannot invent it. What the store hides
 * from the catalog is not offered, and without an id or name there is nothing to pick.
 */
export function wooProductsAsData(products: WooProduct[]): WooDataItem[] {
    const items: WooDataItem[] = [];

    for (const product of products) {
        if (product.id === undefined || !product.name || !isIndexableProduct(product)) continue;

        const inStock = product.stock_status !== 'outofstock';
        const categories = (product.categories ?? []).map((category) => category.name).filter(Boolean);

        items.push({
            id: product.id,
            summary: [product.name, categories.join(', '), inStock ? '' : 'out of stock'].filter(Boolean).join(' · '),
            value: {
                id: product.id,
                name: product.name,
                url: product.permalink,
                price: product.price,
                regularPrice: product.regular_price,
                onSale: product.on_sale === true,
                inStock,
                image: product.images?.[0]
            }
        });
    }

    return items;
}
