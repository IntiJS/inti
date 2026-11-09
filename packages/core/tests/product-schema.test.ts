import { describe, test, expect } from 'bun:test';
import { buildProductSchema, auditProductSchema } from '../src/seo/product.js';
import { buildStructuredData } from '../src/seo/structured-data.js';

// ============================================
// Helpers
// ============================================

const base = {
    name: 'T-shirt',
    images: ['https://shop.com/t-shirt.jpg'],
    url: 'https://shop.com/product/t-shirt'
};

function offersOf(node: Record<string, any>) {
    return node.offers as Record<string, any> | undefined;
}

// ============================================
// What Google requires
// ============================================

describe('buildProductSchema — offer', () => {
    test('emits price, currency and availability', () => {
        const node = buildProductSchema(
            { ...base, offers: { price: '19.99', availability: 'InStock' } },
            { currency: 'EUR' }
        );

        const offer = offersOf(node)!;
        expect(offer['@type']).toBe('Offer');
        expect(offer.price).toBe('19.99');
        expect(offer.priceCurrency).toBe('EUR');
        expect(offer.availability).toBe('https://schema.org/InStock');
    });

    test('availability goes as a full schema.org URL', () => {
        // Google accepts the short form, but the canonical one is the URL and it is
        // the one that raises no warnings in the validator.
        const node = buildProductSchema({ ...base, offers: { availability: 'OutOfStock' } });
        expect(offersOf(node)!.availability).toBe('https://schema.org/OutOfStock');
    });

    test('the offer currency wins over the global one', () => {
        const node = buildProductSchema(
            { ...base, offers: { price: 10, currency: 'USD' } },
            { currency: 'EUR' }
        );
        expect(offersOf(node)!.priceCurrency).toBe('USD');
    });

    test('a numeric price is serialized with two decimals', () => {
        // 19.99 in floating point can print as 19.989999999999998,
        // and Google compares the JSON-LD with what the page shows.
        const node = buildProductSchema({ ...base, offers: { price: 19.99 } });
        expect(offersOf(node)!.price).toBe('19.99');
    });

    test('an integer gains no artificial decimals', () => {
        const node = buildProductSchema({ ...base, offers: { price: 20 } });
        expect(offersOf(node)!.price).toBe('20');
    });
});

// ============================================
// Variations
// ============================================

describe('buildProductSchema — several offers', () => {
    test('a price range is emitted as AggregateOffer', () => {
        const node = buildProductSchema(
            {
                ...base,
                offers: [
                    { price: '19.99', availability: 'InStock' },
                    { price: '29.99', availability: 'InStock' },
                    { price: '24.99', availability: 'OutOfStock' }
                ]
            },
            { currency: 'EUR' }
        );

        const offer = offersOf(node)!;
        expect(offer['@type']).toBe('AggregateOffer');
        expect(offer.lowPrice).toBe('19.99');
        expect(offer.highPrice).toBe('29.99');
        expect(offer.offerCount).toBe(3);
        expect(offer.priceCurrency).toBe('EUR');
    });

    test('with all variations at the same price no range is emitted', () => {
        // "from 19.99 to 19.99" is noise; a simple Offer is correct.
        const node = buildProductSchema({
            ...base,
            offers: [
                { price: '19.99', availability: 'InStock' },
                { price: '19.99', availability: 'InStock' }
            ]
        });

        expect(offersOf(node)!['@type']).toBe('Offer');
        expect(offersOf(node)!.price).toBe('19.99');
    });

    test('the AggregateOffer prefers the availability of an in-stock variation', () => {
        // If any size is available, the product is.
        const node = buildProductSchema({
            ...base,
            offers: [
                { price: '10', availability: 'OutOfStock' },
                { price: '20', availability: 'InStock' }
            ]
        });

        expect(offersOf(node)!.availability).toBe('https://schema.org/InStock');
    });
});

// ============================================
// Ratings
// ============================================

describe('buildProductSchema — aggregateRating', () => {
    test('emits value and number of reviews', () => {
        const node = buildProductSchema({ ...base, rating: { value: 4.5, count: 12 } });
        const rating = node.aggregateRating as Record<string, any>;

        expect(rating['@type']).toBe('AggregateRating');
        expect(rating.ratingValue).toBe('4.5');
        expect(rating.reviewCount).toBe('12');
    });

    test('is omitted without reviews', () => {
        // Google rejects aggregateRating with reviewCount 0.
        const node = buildProductSchema({ ...base, rating: { value: 0, count: 0 } });
        expect(node.aggregateRating).toBeUndefined();
    });

    test('is omitted with reviews but a zero average', () => {
        const node = buildProductSchema({ ...base, rating: { value: 0, count: 5 } });
        expect(node.aggregateRating).toBeUndefined();
    });
});

// ============================================
// Identity fields
// ============================================

describe('buildProductSchema — identity', () => {
    test('sku, gtin, mpn and brand', () => {
        const node = buildProductSchema({
            ...base,
            sku: 'CAM-01',
            gtin: '8412345678905',
            mpn: 'MPN-9',
            brand: 'Acme'
        });

        expect(node.sku).toBe('CAM-01');
        expect(node.gtin).toBe('8412345678905');
        expect(node.mpn).toBe('MPN-9');
        expect(node.brand).toEqual({ '@type': 'Brand', name: 'Acme' });
    });

    test('a single image is not wrapped in an array', () => {
        const node = buildProductSchema(base);
        expect(node.image).toBe('https://shop.com/t-shirt.jpg');
    });

    test('relative images are resolved against baseUrl', () => {
        const node = buildProductSchema(
            { name: 'X', images: ['/img/a.jpg', '/img/b.jpg'] },
            { baseUrl: 'https://shop.com/product/x' }
        );
        expect(node.image).toEqual([
            'https://shop.com/img/a.jpg',
            'https://shop.com/img/b.jpg'
        ]);
    });

    test('empty fields do not reach the JSON-LD', () => {
        const node = buildProductSchema({ name: 'X' });
        expect(Object.keys(node)).toEqual(['@type', 'name']);
    });
});

// ============================================
// Audit
// ============================================

describe('auditProductSchema', () => {
    test('a complete product has no findings', () => {
        const problems = auditProductSchema(
            { ...base, offers: { price: '10', availability: 'InStock' } },
            { currency: 'EUR' }
        );
        expect(problems).toHaveLength(0);
    });

    test('warns that without offers or rating there is no rich result', () => {
        const problems = auditProductSchema(base);
        expect(problems.join(' ')).toMatch(/offers.*rating|rating.*offers/i);
    });

    test('warns about the missing currency, the typical oversight', () => {
        // WooCommerce does not include it in the product response.
        const problems = auditProductSchema({ ...base, offers: { price: '10', availability: 'InStock' } });
        expect(problems.join(' ')).toMatch(/currency/i);
    });

    test('warns about the missing availability', () => {
        const problems = auditProductSchema({ ...base, offers: { price: '10' } }, { currency: 'EUR' });
        expect(problems.join(' ')).toMatch(/availability/i);
    });

    test('warns about the missing image', () => {
        const problems = auditProductSchema(
            { name: 'X', offers: { price: '1', availability: 'InStock' } },
            { currency: 'EUR' }
        );
        expect(problems.join(' ')).toMatch(/images/i);
    });
});

// ============================================
// Integration with the page's graph
// ============================================

describe('buildStructuredData with a product', () => {
    test('the product is the main node, not a WebPage', () => {
        const data = buildStructuredData(
            { title: 'T-shirt', blocks: [] },
            {
                url: 'https://shop.com/product/t-shirt',
                product: { name: 'T-shirt', offers: { price: '19.99', availability: 'InStock' } },
                currency: 'EUR'
            }
        );

        const graph = data!['@graph'] as Array<Record<string, any>>;
        expect(graph[0]['@type']).toBe('Product');
        expect(graph[0].offers.price).toBe('19.99');
    });

    test('breadcrumbs are still added alongside the product', () => {
        const data = buildStructuredData(null, {
            url: 'https://shop.com/product/t-shirt',
            product: { name: 'T-shirt', offers: { price: '1', availability: 'InStock' } },
            currency: 'EUR',
            breadcrumbs: [
                { name: 'Home', url: 'https://shop.com/' },
                { name: 'T-shirts', url: 'https://shop.com/t-shirts/' }
            ]
        });

        const types = (data!['@graph'] as Array<Record<string, any>>).map((n) => n['@type']);
        expect(types).toEqual(['Product', 'BreadcrumbList']);
    });

    test('without product data the previous behavior is kept', () => {
        const data = buildStructuredData(
            { title: 'Hello', blocks: [] },
            { url: 'https://x.com/', type: 'WebPage' }
        );
        const graph = data!['@graph'] as Array<Record<string, any>>;
        expect(graph[0]['@type']).toBe('WebPage');
    });
});
