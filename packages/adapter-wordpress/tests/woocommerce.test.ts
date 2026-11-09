import { describe, test, expect } from 'bun:test';
import {
    productFromWooCommerce,
    mapStockStatus,
    isIndexableProduct,
    wooProductsAsData
} from '../src/woocommerce.js';
import type { WooProduct } from '../src/woocommerce.js';

// ============================================
// Realistic wc/v3 payload
// ============================================

const wcProduct: WooProduct = {
    name: 'Organic T-Shirt',
    slug: 'organic-t-shirt',
    permalink: 'https://shop.example.com/product/organic-t-shirt/',
    description: '<p>Certified <strong>100%</strong> organic cotton.</p>',
    short_description: '<p>Organic cotton t-shirt.</p>',
    sku: 'CAM-ORG-01',
    global_unique_id: '8412345678905',
    price: '19.99',
    regular_price: '24.99',
    sale_price: '19.99',
    on_sale: true,
    date_on_sale_to: '2026-12-31T23:59:59',
    stock_status: 'instock',
    stock_quantity: 42,
    type: 'simple',
    status: 'publish',
    catalog_visibility: 'visible',
    images: [
        { src: 'https://shop.example.com/wp-content/uploads/tshirt-1.jpg', alt: 'Front' },
        { src: 'https://shop.example.com/wp-content/uploads/tshirt-2.jpg', alt: 'Back' }
    ],
    categories: [{ name: 'T-Shirts', slug: 't-shirts' }],
    brands: [{ name: 'Acme' }],
    average_rating: '4.50',
    rating_count: 12
};

// ============================================
// Availability mapping
// ============================================

describe('mapStockStatus', () => {
    test('translates the three WooCommerce statuses', () => {
        expect(mapStockStatus('instock')).toBe('InStock');
        expect(mapStockStatus('outofstock')).toBe('OutOfStock');
        expect(mapStockStatus('onbackorder')).toBe('BackOrder');
    });

    test('an unknown status is not assumed to be available', () => {
        // Announcing "In stock" on a sold-out product makes Google flag
        // the page as having invalid structured data.
        expect(mapStockStatus('who-knows')).toBeUndefined();
        expect(mapStockStatus(undefined)).toBeUndefined();
    });
});

// ============================================
// Simple product
// ============================================

describe('productFromWooCommerce — simple product', () => {
    test('maps the identity fields', () => {
        const product = productFromWooCommerce(wcProduct, { currency: 'EUR' });

        expect(product.name).toBe('Organic T-Shirt');
        expect(product.sku).toBe('CAM-ORG-01');
        expect(product.gtin).toBe('8412345678905');
        expect(product.brand).toBe('Acme');
        expect(product.category).toBe('T-Shirts');
        expect(product.url).toBe('https://shop.example.com/product/organic-t-shirt/');
    });

    test('collects all the images', () => {
        const product = productFromWooCommerce(wcProduct);
        expect(product.images).toHaveLength(2);
        expect(product.images?.[0]).toContain('tshirt-1.jpg');
    });

    test('strips the HTML from the description', () => {
        const product = productFromWooCommerce(wcProduct);
        expect(product.description).toBe('Organic cotton t-shirt.');
    });

    test('uses the long description if requested', () => {
        const product = productFromWooCommerce(wcProduct, { useFullDescription: true });
        expect(product.description).toBe('Certified 100% organic cotton.');
    });

    test('builds the offer with price, currency and availability', () => {
        const product = productFromWooCommerce(wcProduct, { currency: 'EUR' });
        const offers = Array.isArray(product.offers) ? product.offers : [product.offers!];

        expect(offers).toHaveLength(1);
        expect(offers[0].price).toBe('19.99');
        expect(offers[0].currency).toBe('EUR');
        expect(offers[0].availability).toBe('InStock');
    });

    test('on sale, propagates the end date as priceValidUntil', () => {
        const product = productFromWooCommerce(wcProduct, { currency: 'EUR' });
        const offers = Array.isArray(product.offers) ? product.offers : [product.offers!];
        expect(offers[0].priceValidUntil).toBe('2026-12-31T23:59:59');
    });

    test('without an active sale no validity date is propagated', () => {
        const product = productFromWooCommerce(
            { ...wcProduct, on_sale: false },
            { currency: 'EUR' }
        );
        const offers = Array.isArray(product.offers) ? product.offers : [product.offers!];
        expect(offers[0].priceValidUntil).toBeUndefined();
    });

    test('maps the average rating', () => {
        const product = productFromWooCommerce(wcProduct);
        expect(product.rating).toEqual({ value: 4.5, count: 12, best: 5, worst: 1 });
    });

    test('without reviews no rating is invented', () => {
        // WooCommerce returns average_rating "0.00" and rating_count 0.
        const product = productFromWooCommerce({
            ...wcProduct,
            average_rating: '0.00',
            rating_count: 0
        });
        expect(product.rating).toBeUndefined();
    });
});

// ============================================
// Variable product
// ============================================

describe('productFromWooCommerce — variable product', () => {
    const variable: WooProduct = { ...wcProduct, type: 'variable', price: '19.99' };

    test('without fetched variations it uses the base price', () => {
        // In WooCommerce the `price` of a variable product is the minimum, so
        // it is correct even though it shows no range.
        const product = productFromWooCommerce(variable, { currency: 'EUR' });
        const offers = Array.isArray(product.offers) ? product.offers : [product.offers!];

        expect(offers).toHaveLength(1);
        expect(offers[0].price).toBe('19.99');
    });

    test('with variations it emits one offer per variation', () => {
        const product = productFromWooCommerce(variable, {
            currency: 'EUR',
            variations: [
                { price: '19.99', stock_status: 'instock' },
                { price: '24.99', stock_status: 'instock' },
                { price: '29.99', stock_status: 'outofstock' }
            ]
        });

        const offers = Array.isArray(product.offers) ? product.offers : [product.offers!];
        expect(offers).toHaveLength(3);
        expect(offers.map((o) => o.price)).toEqual(['19.99', '24.99', '29.99']);
        expect(offers[2].availability).toBe('OutOfStock');
    });
});

// ============================================
// Edge cases
// ============================================

describe('productFromWooCommerce — incomplete data', () => {
    test('an empty product does not blow up', () => {
        const product = productFromWooCommerce({});
        expect(product.name).toBe('');
        expect(product.images).toEqual([]);
    });

    test('an empty sku does not arrive as an empty string', () => {
        const product = productFromWooCommerce({ ...wcProduct, sku: '' });
        expect(product.sku).toBeUndefined();
    });

    test('without a native brand the fallback one is used', () => {
        const product = productFromWooCommerce(
            { ...wcProduct, brands: undefined },
            { brand: 'Store Brand' }
        );
        expect(product.brand).toBe('Store Brand');
    });

    test('falls back to regular_price if there is no price', () => {
        const product = productFromWooCommerce({
            ...wcProduct,
            price: undefined,
            sale_price: undefined,
            regular_price: '24.99'
        });
        const offers = Array.isArray(product.offers) ? product.offers : [product.offers!];
        expect(offers[0].price).toBe('24.99');
    });
});

// ============================================
// Indexability
// ============================================

describe('isIndexableProduct', () => {
    test('a published, visible product is indexed', () => {
        expect(isIndexableProduct(wcProduct)).toBe(true);
    });

    test('a draft is not indexed', () => {
        expect(isIndexableProduct({ ...wcProduct, status: 'draft' })).toBe(false);
    });

    test('a product hidden from the catalog is not indexed', () => {
        // WooCommerce serves them through the API anyway; indexing them produces
        // pages that Search Console flags as thin content.
        expect(isIndexableProduct({ ...wcProduct, catalog_visibility: 'hidden' })).toBe(false);
    });

    test('without status fields it is assumed indexable', () => {
        expect(isIndexableProduct({ name: 'X' })).toBe(true);
    });
});

describe('wooProductsAsData', () => {
    const product = {
        id: 7,
        name: 'Boot',
        price: '120',
        regular_price: '150',
        on_sale: true,
        stock_status: 'instock',
        permalink: 'https://shop/boot',
        categories: [{ name: 'Footwear' }],
        images: [{ src: 'https://shop/boot.jpg', alt: 'Boot' }]
    };

    test('the model sees a summary without the price; the price stays in the value', () => {
        const [item] = wooProductsAsData([product]);
        expect(item.summary).toBe('Boot · Footwear');
        expect(item.summary).not.toContain('120');
        expect(item.value.price).toBe('120');
        expect(item.value.onSale).toBe(true);
    });

    test('what is hidden from the catalog and what cannot be identified is not offered', () => {
        const items = wooProductsAsData([
            { ...product, status: 'draft' },
            { ...product, catalog_visibility: 'hidden' },
            { ...product, id: undefined },
            { ...product, name: undefined }
        ]);
        expect(items).toEqual([]);
    });

    test('says when it is out of stock', () => {
        const [item] = wooProductsAsData([{ ...product, stock_status: 'outofstock' }]);
        expect(item.summary).toContain('out of stock');
        expect(item.value.inStock).toBe(false);
    });
});
