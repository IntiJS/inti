/**
 * Product JSON-LD.
 *
 * Kept apart from the rest of the structured data because a product is
 * not a page with blocks: it is an entity with a fixed schema, and the
 * fields Google cares about come from the catalog, not from any block.
 *
 * Google shows no product rich results just for declaring `@type:
 * Product`. It requires `offers` with price, currency and availability, or
 * else `review`/`aggregateRating`. A node with none of that validates but
 * achieves nothing, which is worse than leaving it out: it looks like it
 * is done.
 *
 * This module is CMS-agnostic. The mapping from WooCommerce lives in
 * `@intijs/adapter-wordpress`, as do the Yoast and RankMath ones.
 */

import type { JsonLdNode } from './structured-data.js';

/** `schema.org/ItemAvailability` values that Google accepts */
export type ProductAvailability =
    | 'InStock'
    | 'OutOfStock'
    | 'PreOrder'
    | 'BackOrder'
    | 'LimitedAvailability'
    | 'SoldOut'
    | 'Discontinued';

export type ProductCondition =
    | 'NewCondition'
    | 'UsedCondition'
    | 'RefurbishedCondition'
    | 'DamagedCondition';

export interface ProductOffer {
    price?: string | number;
    /**
     * ISO 4217 code ('EUR', 'USD'…).
     *
     * Google requires it. It does not usually come in the product response
     * —in WooCommerce it is a store setting, not an item one— so it almost
     * always has to be passed by hand.
     */
    currency?: string;
    availability?: ProductAvailability;
    /** Purchase URL. Defaults to the product's */
    url?: string;
    /** ISO date until which the price is valid (sales) */
    priceValidUntil?: string;
    condition?: ProductCondition;
    seller?: string;
}

export interface ProductRating {
    value: number | string;
    count: number | string;
    best?: number;
    worst?: number;
}

export interface ProductInput {
    name: string;
    description?: string;
    /** One or several; schema.org accepts a list and prefers several aspect ratios */
    images?: string[];
    url?: string;
    sku?: string;
    /** Global barcode (EAN, UPC, ISBN…) */
    gtin?: string;
    /** Manufacturer part number */
    mpn?: string;
    brand?: string;
    category?: string;
    /**
     * One offer, or several for a product with variations.
     * With more than one, an `AggregateOffer` with the minimum and maximum
     * price is emitted, which is how schema.org represents a range.
     */
    offers?: ProductOffer | ProductOffer[];
    rating?: ProductRating;
}

export interface ProductSchemaOptions {
    /** Default currency for offers that do not carry their own */
    currency?: string;
    /** Base to resolve relative images or URLs */
    baseUrl?: string;
}

function omitEmpty(node: JsonLdNode): JsonLdNode {
    const clean: JsonLdNode = {};
    for (const [key, value] of Object.entries(node)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        clean[key] = value;
    }
    return clean;
}

function absolute(url: string | undefined, base: string | undefined): string | undefined {
    if (!url) return undefined;
    if (/^https?:\/\//i.test(url)) return url;
    if (!base) return undefined;
    try {
        return new URL(url, base).toString();
    } catch {
        return undefined;
    }
}

/**
 * Prices go as strings in JSON-LD. A floating point number may serialize
 * as `19.989999999` and Google compares it with what it sees on the page,
 * so it is normalized to two decimals when needed and the string is kept
 * if it already came formatted.
 */
function normalizePrice(price: string | number | undefined): string | undefined {
    if (price === undefined || price === null || price === '') return undefined;

    if (typeof price === 'string') {
        const trimmed = price.trim();
        return trimmed === '' ? undefined : trimmed;
    }

    if (!Number.isFinite(price)) return undefined;
    return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

/** Compares prices as numbers even when they arrive as strings */
function priceValue(price: string | number | undefined): number | null {
    const normalized = normalizePrice(price);
    if (normalized === undefined) return null;
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
}

function offerNode(
    offer: ProductOffer,
    fallbackUrl: string | undefined,
    options: ProductSchemaOptions
): JsonLdNode {
    return omitEmpty({
        '@type': 'Offer',
        price: normalizePrice(offer.price),
        priceCurrency: offer.currency ?? options.currency,
        availability: offer.availability ? `https://schema.org/${offer.availability}` : undefined,
        itemCondition: offer.condition ? `https://schema.org/${offer.condition}` : undefined,
        url: absolute(offer.url, options.baseUrl) ?? fallbackUrl,
        priceValidUntil: offer.priceValidUntil,
        seller: offer.seller ? { '@type': 'Organization', name: offer.seller } : undefined
    });
}

/**
 * Several offers are represented as an `AggregateOffer` with the price
 * range, not as a list of `Offer`: it is what Google expects from a
 * product with variations and what lets it show "from X".
 */
function aggregateOfferNode(
    offers: ProductOffer[],
    fallbackUrl: string | undefined,
    options: ProductSchemaOptions
): JsonLdNode | undefined {
    const prices = offers
        .map((offer) => priceValue(offer.price))
        .filter((value): value is number => value !== null);

    if (prices.length === 0) return undefined;

    const low = Math.min(...prices);
    const high = Math.max(...prices);

    // With every variation at the same price, a range is pointless.
    if (low === high && offers.length > 0) {
        return offerNode({ ...offers[0], price: low }, fallbackUrl, options);
    }

    const currency = offers.find((offer) => offer.currency)?.currency ?? options.currency;
    const available = offers.find((offer) => offer.availability === 'InStock') ?? offers[0];

    return omitEmpty({
        '@type': 'AggregateOffer',
        lowPrice: normalizePrice(low),
        highPrice: normalizePrice(high),
        priceCurrency: currency,
        offerCount: offers.length,
        availability: available?.availability
            ? `https://schema.org/${available.availability}`
            : undefined,
        url: fallbackUrl
    });
}

function ratingNode(rating: ProductRating): JsonLdNode | undefined {
    const count = Number(rating.count);
    const value = Number(rating.value);

    // Google rejects aggregateRating without reviews, and a 0 out of 0 votes
    // is shown as an average of zero instead of being omitted.
    if (!Number.isFinite(count) || count <= 0) return undefined;
    if (!Number.isFinite(value) || value <= 0) return undefined;

    return omitEmpty({
        '@type': 'AggregateRating',
        ratingValue: String(value),
        reviewCount: String(count),
        bestRating: rating.best !== undefined ? String(rating.best) : undefined,
        worstRating: rating.worst !== undefined ? String(rating.worst) : undefined
    });
}

/**
 * Builds the schema.org `Product` node.
 *
 * Meant to be used standalone: products are usually Astro pages that
 * query the catalog directly, without going through the adapter
 * contract, which exists for the editing layer.
 */
export function buildProductSchema(
    product: ProductInput,
    options: ProductSchemaOptions = {}
): JsonLdNode {
    const url = absolute(product.url, options.baseUrl);

    const images = (product.images ?? [])
        .map((image) => absolute(image, options.baseUrl))
        .filter((image): image is string => !!image);

    const offerList = product.offers
        ? Array.isArray(product.offers)
            ? product.offers
            : [product.offers]
        : [];

    const offers =
        offerList.length > 1
            ? aggregateOfferNode(offerList, url, options)
            : offerList.length === 1
              ? offerNode(offerList[0], url, options)
              : undefined;

    return omitEmpty({
        '@type': 'Product',
        name: product.name,
        description: product.description,
        image: images.length === 1 ? images[0] : images,
        url,
        sku: product.sku,
        gtin: product.gtin,
        mpn: product.mpn,
        brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
        category: product.category,
        offers,
        aggregateRating: product.rating ? ratingNode(product.rating) : undefined
    });
}

/**
 * What a product is missing to get rich results.
 *
 * Returned instead of thrown because an incomplete product must still
 * render; what it must not do is go unnoticed. It fits with the SEO
 * auditor that already walks the pages at build time.
 */
export function auditProductSchema(product: ProductInput, options: ProductSchemaOptions = {}): string[] {
    const problems: string[] = [];

    if (!product.name) problems.push('Missing "name": Google does not show a product without a name.');
    if (!product.images?.length) problems.push('Missing "images": the product rich result carries an image.');

    const offerList = product.offers
        ? Array.isArray(product.offers)
            ? product.offers
            : [product.offers]
        : [];

    if (offerList.length === 0 && !product.rating) {
        problems.push(
            'Without "offers" or "rating" there is no rich result: Google requires one of the two.'
        );
        return problems;
    }

    if (offerList.length > 0) {
        if (offerList.every((offer) => priceValue(offer.price) === null)) {
            problems.push('The offers carry no price: "offers.price" is required.');
        }
        if (!options.currency && offerList.every((offer) => !offer.currency)) {
            problems.push(
                'Missing currency: pass "currency" (ISO 4217, e.g. "EUR"). ' +
                'WooCommerce does not include it in the product response.'
            );
        }
        if (offerList.every((offer) => !offer.availability)) {
            problems.push('Missing "availability": Google shows "In stock" based on this field.');
        }
    }

    return problems;
}
