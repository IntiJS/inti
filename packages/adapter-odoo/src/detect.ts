/**
 * What this Odoo has: which modules are installed and what their fields are called.
 *
 * An Odoo database is shaped by its modules. `stock` adds `free_qty` (on hand minus what is
 * reserved: what can be sold now); `website_sale` adds `is_published` and public categories;
 * Odoo 18 replaced `detailed_type` with `is_storable`; the tax "price included" flag changed its
 * name. The adapter asks `fields_get` once instead of assuming a version, so the same code reads
 * a bare `sale` database and a full shop.
 */

import type { OdooClient } from './client.js';

export interface OdooCapabilities {
    /** `stock`: `free_qty` can be read on variants */
    stock: boolean;
    /** `website_sale`: products have `is_published` and public categories */
    website: boolean;
    /** Name of the categories model customers browse: `product.public.category` or `product.category` */
    categoryModel: 'product.public.category' | 'product.category';
    /** Field of a template holding those categories */
    categoryField: 'public_categ_ids' | 'categ_id';
    /** How a template says its stock is tracked: `is_storable` (18+) or `detailed_type` (17) */
    storableField: 'is_storable' | 'detailed_type' | null;
    /** The tax flag for "price includes the tax": `price_include_override` (18+) or `price_include` */
    taxIncludeField: 'price_include_override' | 'price_include' | null;
    /** Template fields that exist, among the optional ones the adapter reads */
    templateFields: Set<string>;
    /** Variant fields that exist */
    variantFields: Set<string>;
}

const OPTIONAL_TEMPLATE = [
    'default_code',
    'barcode',
    'description_sale',
    'description_ecommerce',
    'website_description',
    'compare_list_price',
    'is_published',
    'website_url',
    'public_categ_ids',
    'sale_ok',
    'is_storable',
    'detailed_type',
    'type',
    'currency_id',
    'taxes_id',
    'product_variant_ids',
    'product_variant_count',
    'write_date'
];

const OPTIONAL_VARIANT = ['default_code', 'barcode', 'free_qty', 'qty_available', 'lst_price', 'product_template_attribute_value_ids', 'write_date', 'active'];

export async function detectOdoo(client: OdooClient): Promise<OdooCapabilities> {
    const [template, variant, tax] = await Promise.all([
        client.fieldsGet('product.template'),
        client.fieldsGet('product.product'),
        client.fieldsGet('account.tax').catch(() => ({}) as Record<string, unknown>)
    ]);
    const website = 'is_published' in template && 'public_categ_ids' in template;
    return {
        stock: 'free_qty' in variant,
        website,
        categoryModel: website ? 'product.public.category' : 'product.category',
        categoryField: website ? 'public_categ_ids' : 'categ_id',
        storableField: 'is_storable' in template ? 'is_storable' : 'detailed_type' in template ? 'detailed_type' : null,
        taxIncludeField: 'price_include_override' in tax ? 'price_include_override' : 'price_include' in tax ? 'price_include' : null,
        templateFields: new Set(OPTIONAL_TEMPLATE.filter((field) => field in template)),
        variantFields: new Set(OPTIONAL_VARIANT.filter((field) => field in variant))
    };
}
