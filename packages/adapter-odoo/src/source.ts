/**
 * Odoo products as a `CatalogSource`.
 *
 * - **Identity by internal reference.** An item is addressed by the template's `default_code`
 *   (`/products/blue-shirt--SH-001`), never by a variant id: ids change when a database is
 *   migrated or variants are regenerated, references do not. A template without a reference is
 *   `tmpl-<id>`. A variant is found by its own reference too.
 * - **Variants** with their attribute values as options, their price (`lst_price`, extras
 *   included) and their stock.
 * - **Stock "free to use"** (`free_qty`: on hand minus reserved), the quantity that can really
 *   be sold. Products whose stock is not tracked are always available.
 * - **Prices with or without taxes**, computed from the product's sale taxes the way Odoo does
 *   for percent, fixed and division taxes, whether the price is stored tax-included or not.
 * - **Published only**: `sale_ok`, and `is_published` when the website module is installed.
 * - **Images** through the site's own proxy (`odooImageRoute`), versioned by `write_date`.
 */

import type {
    CatalogCollection,
    CatalogItem,
    CatalogPage,
    CatalogQuery,
    CatalogSource,
    CatalogSummaryPage,
    CatalogVariant
} from '@intijs/core/catalog';

import type { OdooClient, OdooDomain } from './client.js';
import { detectOdoo, type OdooCapabilities } from './detect.js';

export interface OdooCatalogOptions {
    client: OdooClient;
    /** Catalog name: the purge route and the bound blocks use it. Default `odoo` */
    name?: string;
    /** Prices shown with taxes (`included`, the default: what a consumer pays) or without */
    taxes?: 'included' | 'excluded';
    /** Path of the image proxy on the site. Default `/media/odoo` */
    imagePath?: string;
    /** Size of the images in `images`: `image_512`, `image_1024` (default) or `image_1920` */
    imageSize?: 'image_512' | 'image_1024' | 'image_1920';
    /** Only the taxes of this company, in a multi-company database */
    companyId?: number;
    /** More conditions every product must meet: `[['categ_id.name', '=', 'Shop']]` */
    domain?: OdooDomain;
}

type Many2one = [number, string] | false;

interface Template {
    id: number;
    name: string;
    default_code?: string | false;
    barcode?: string | false;
    description_sale?: string | false;
    description_ecommerce?: string | false;
    list_price: number;
    compare_list_price?: number;
    currency_id?: Many2one;
    taxes_id?: number[];
    product_variant_ids?: number[];
    product_template_image_ids?: number[];
    public_categ_ids?: number[];
    categ_id?: Many2one;
    is_storable?: boolean;
    detailed_type?: string;
    type?: string;
    write_date?: string;
}

interface Variant {
    id: number;
    default_code?: string | false;
    barcode?: string | false;
    lst_price?: number;
    free_qty?: number;
    product_template_attribute_value_ids?: number[];
    product_tmpl_id?: Many2one;
}

interface Tax {
    id: number;
    amount: number;
    amount_type: string;
    price_include?: boolean;
    price_include_override?: string | false;
    company_id?: Many2one;
}

const TEMPLATE_PREFIX = 'tmpl-';
const SEPARATOR = '--';

export const slugify = (value: string) =>
    value
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'product';

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The item id of a template: its reference, or `tmpl-<id>` */
export const referenceOf = (template: Pick<Template, 'id' | 'default_code'>) => text(template.default_code) ?? `${TEMPLATE_PREFIX}${template.id}`;

/** `blue-shirt--SH-001`: readable, and the reference after the last `--` */
export const odooSlug = (name: string, reference: string) => `${slugify(name)}${SEPARATOR}${encodeURIComponent(reference)}`;

/** The reference a slug carries (also accepts a bare reference) */
export function referenceFromSlug(slug: string): string {
    const at = slug.lastIndexOf(SEPARATOR);
    const raw = at >= 0 ? slug.slice(at + SEPARATOR.length) : slug;
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/** Collection slug: `shirts-12` */
const collectionSlug = (name: string, id: number) => `${slugify(name)}-${id}`;
const collectionId = (slug: string) => Number(slug.match(/-(\d+)$/)?.[1] ?? slug.match(/^(\d+)$/)?.[1] ?? NaN);

/** A price with or without the given taxes, as Odoo computes percent, fixed and division taxes */
export function applyTaxes(price: number, taxes: Tax[], want: 'included' | 'excluded', includeField: OdooCapabilities['taxIncludeField']): number {
    const included = (tax: Tax) =>
        includeField === 'price_include_override' ? tax.price_include_override === 'tax_included' : Boolean(tax.price_include);
    // First the stored price without the taxes it already includes
    let base = price;
    for (const tax of taxes.filter(included)) {
        if (tax.amount_type === 'percent') base = base / (1 + tax.amount / 100);
        else if (tax.amount_type === 'fixed') base = base - tax.amount;
        else if (tax.amount_type === 'division') base = base * (1 - tax.amount / 100);
    }
    if (want === 'excluded') return round(base);
    let total = base;
    for (const tax of taxes) {
        if (tax.amount_type === 'percent') total += base * (tax.amount / 100);
        else if (tax.amount_type === 'fixed') total += tax.amount;
        else if (tax.amount_type === 'division') total += base / (1 - tax.amount / 100) - base;
    }
    return round(total);
}

const round = (value: number) => Math.round(value * 100) / 100;

export function odooCatalogSource(options: OdooCatalogOptions): CatalogSource & { capabilities(): Promise<OdooCapabilities> } {
    const { client } = options;
    const name = options.name ?? 'odoo';
    const want = options.taxes ?? 'included';
    const imagePath = (options.imagePath ?? '/media/odoo').replace(/\/+$/, '');
    const imageSize = options.imageSize ?? 'image_1024';

    let detected: Promise<OdooCapabilities> | null = null;
    const capabilities = () => {
        detected ??= detectOdoo(client).catch((error) => {
            detected = null;
            throw error;
        });
        return detected;
    };

    const published = (caps: OdooCapabilities): OdooDomain => [
        ['sale_ok', '=', true],
        ...(caps.website ? ([['is_published', '=', true]] as OdooDomain) : []),
        ...(options.domain ?? [])
    ];

    const templateFields = (caps: OdooCapabilities) =>
        [
            'id',
            'name',
            'list_price',
            caps.categoryField,
            ...[
                'default_code',
                'barcode',
                'description_sale',
                'description_ecommerce',
                'compare_list_price',
                'currency_id',
                'taxes_id',
                'product_variant_ids',
                'write_date',
                caps.storableField ?? '',
                'type'
            ].filter((field) => caps.templateFields.has(field)),
            ...(caps.website ? ['product_template_image_ids'] : [])
        ].filter(Boolean);

    const version = (date: string | undefined) => (date ? date.replace(/\D/g, '') : '0');
    const imageUrl = (model: string, id: number, date: string | undefined) => `${imagePath}/${model}/${id}/${imageSize}?v=${version(date)}`;

    /** Builds items from templates, reading their variants, attribute values and taxes in a few calls */
    async function build(templates: Template[], caps: OdooCapabilities): Promise<CatalogItem[]> {
        if (templates.length === 0) return [];
        const variantIds = templates.flatMap((template) => template.product_variant_ids ?? []);
        const taxIds = [...new Set(templates.flatMap((template) => template.taxes_id ?? []))];

        const variantFields = ['id', 'product_tmpl_id', ...['default_code', 'barcode', 'lst_price', 'free_qty', 'product_template_attribute_value_ids'].filter((field) => caps.variantFields.has(field))];
        const [variants, taxes] = await Promise.all([
            variantIds.length ? client.read<Variant>('product.product', variantIds, variantFields) : Promise.resolve([] as Variant[]),
            taxIds.length && caps.taxIncludeField !== undefined
                ? client.read<Tax>('account.tax', taxIds, ['id', 'amount', 'amount_type', 'company_id', ...(caps.taxIncludeField ? [caps.taxIncludeField] : [])])
                : Promise.resolve([] as Tax[])
        ]);

        const valueIds = [...new Set(variants.flatMap((variant) => variant.product_template_attribute_value_ids ?? []))];
        const values = valueIds.length
            ? await client.read<{ id: number; name: string; attribute_id: Many2one }>('product.template.attribute.value', valueIds, ['id', 'name', 'attribute_id'])
            : [];
        const valueById = new Map(values.map((value) => [value.id, value]));
        // Category names, for readable collection slugs
        const categoryIds = caps.categoryField === 'public_categ_ids' ? [...new Set(templates.flatMap((template) => template.public_categ_ids ?? []))] : [];
        const categoryNames = new Map(
            (categoryIds.length ? await client.read<{ id: number; name: string }>(caps.categoryModel, categoryIds, ['id', 'name']) : []).map((row) => [row.id, row.name])
        );
        const taxById = new Map(
            taxes.filter((tax) => !options.companyId || (tax.company_id && tax.company_id[0] === options.companyId)).map((tax) => [tax.id, tax])
        );
        const variantById = new Map(variants.map((variant) => [variant.id, variant]));

        return templates.map((template) => {
            const reference = referenceOf(template);
            const productTaxes = (template.taxes_id ?? []).map((id) => taxById.get(id)).filter((tax): tax is Tax => Boolean(tax));
            const price = (amount: number) => applyTaxes(amount, productTaxes, want, caps.taxIncludeField);
            const currency = template.currency_id ? template.currency_id[1] : undefined;
            const storable = caps.storableField === 'is_storable' ? Boolean(template.is_storable) : caps.storableField === 'detailed_type' ? template.detailed_type === 'product' : false;
            const tracked = caps.stock && storable;

            const ownVariants = (template.product_variant_ids ?? []).map((id) => variantById.get(id)).filter((variant): variant is Variant => Boolean(variant));
            const catalogVariants: CatalogVariant[] = ownVariants.map((variant) => {
                const options: Record<string, string> = {};
                for (const id of variant.product_template_attribute_value_ids ?? []) {
                    const value = valueById.get(id);
                    if (value?.attribute_id) options[value.attribute_id[1]] = value.name;
                }
                const quantity = tracked ? Math.max(0, variant.free_qty ?? 0) : undefined;
                return {
                    id: text(variant.default_code) ?? `${TEMPLATE_PREFIX}${template.id}-${variant.id}`,
                    sku: text(variant.default_code),
                    barcode: text(variant.barcode),
                    options,
                    price: { amount: price(variant.lst_price ?? template.list_price), currency },
                    availability: quantity === undefined ? 'InStock' : quantity > 0 ? 'InStock' : 'OutOfStock',
                    quantity
                };
            });

            const quantity = tracked ? catalogVariants.reduce((sum, variant) => sum + (variant.quantity ?? 0), 0) : undefined;
            const lowest = catalogVariants.length
                ? Math.min(...catalogVariants.map((variant) => Number(variant.price?.amount ?? Infinity)))
                : price(template.list_price);
            const compare = template.compare_list_price ? price(template.compare_list_price) : undefined;
            const categories: Array<[number, string]> =
                caps.categoryField === 'public_categ_ids'
                    ? (template.public_categ_ids ?? []).map((id) => [id, categoryNames.get(id) ?? String(id)])
                    : template.categ_id
                      ? [[template.categ_id[0], template.categ_id[1].split(' / ').pop() ?? template.categ_id[1]]]
                      : [];

            return {
                id: reference,
                slug: odooSlug(template.name, reference),
                title: template.name,
                description: text(template.description_ecommerce) ?? text(template.description_sale),
                images: [
                    imageUrl('product.template', template.id, template.write_date),
                    ...(template.product_template_image_ids ?? []).map((id) => imageUrl('product.image', id, template.write_date))
                ],
                sku: text(template.default_code),
                barcode: text(template.barcode),
                collections: categories.map(([id, title]) => ({ id: String(id), slug: collectionSlug(title, id), title })),
                price: { amount: Number.isFinite(lowest) ? lowest : price(template.list_price), currency, compareAt: compare },
                availability: quantity === undefined ? 'InStock' : quantity > 0 ? 'InStock' : 'OutOfStock',
                quantity,
                variants: catalogVariants.length > 1 ? catalogVariants : undefined,
                updatedAt: template.write_date ? `${template.write_date.replace(' ', 'T')}Z` : undefined,
                extra: { odooId: template.id, taxes: want }
            };
        });
    }

    function domainFor(query: CatalogQuery, caps: OdooCapabilities): OdooDomain {
        const domain: OdooDomain = [...published(caps)];
        if (query.search) domain.push('|', ['name', 'ilike', query.search], ['default_code', 'ilike', query.search]);
        if (query.collection) {
            const id = collectionId(query.collection);
            if (Number.isFinite(id)) domain.push([caps.categoryField, 'child_of', id]);
        }
        if (query.priceMin !== undefined) domain.push(['list_price', '>=', query.priceMin]);
        if (query.priceMax !== undefined) domain.push(['list_price', '<=', query.priceMax]);
        if (query.inStock && caps.stock) {
            // Not tracked, or something free to use in some variant
            const storable: OdooDomain = caps.storableField === 'is_storable' ? [['is_storable', '=', false]] : caps.storableField === 'detailed_type' ? [['detailed_type', '!=', 'product']] : [];
            if (storable.length) domain.push('|', ...storable, ['product_variant_ids.free_qty', '>', 0]);
            else domain.push(['product_variant_ids.free_qty', '>', 0]);
        }
        for (const [attribute, accepted] of Object.entries(query.filters ?? {})) {
            if (!accepted.length) continue;
            domain.push(['attribute_line_ids', 'any', [['attribute_id.name', '=', attribute], ['value_ids.name', 'in', accepted]]]);
        }
        return domain;
    }

    const ORDER: Record<string, string> = {
        name: 'name asc, id asc',
        'price-asc': 'list_price asc, id asc',
        'price-desc': 'list_price desc, id asc',
        newest: 'create_date desc, id desc',
        relevance: 'website_sequence asc, id asc'
    };

    return {
        name,
        capabilities,
        idOf: (slug) => referenceFromSlug(slug),

        async getItem(slug) {
            const caps = await capabilities();
            const reference = referenceFromSlug(slug);
            const fields = templateFields(caps);
            let templates: Template[];
            const byId = reference.startsWith(TEMPLATE_PREFIX) ? Number(reference.slice(TEMPLATE_PREFIX.length)) : NaN;
            if (Number.isInteger(byId)) {
                templates = await client.searchRead<Template>('product.template', [...published(caps), ['id', '=', byId], ['default_code', 'in', [false, '']]], fields, { limit: 1 });
            } else {
                templates = await client.searchRead<Template>('product.template', [...published(caps), ['default_code', '=', reference]], fields, { limit: 1 });
                if (templates.length === 0) {
                    // The reference of one variant: its product
                    const variants = await client.searchRead<Variant>('product.product', [['default_code', '=', reference]], ['product_tmpl_id'], { limit: 1 });
                    const template = variants[0]?.product_tmpl_id;
                    if (template) templates = await client.searchRead<Template>('product.template', [...published(caps), ['id', '=', template[0]]], fields, { limit: 1 });
                }
            }
            const [item] = await build(templates, caps);
            return item ?? null;
        },

        async list(query: CatalogQuery = {}): Promise<CatalogPage> {
            const caps = await capabilities();
            const domain = domainFor(query, caps);
            const pageSize = Math.max(1, Math.min(100, query.pageSize ?? 24));
            const page = Math.max(1, query.page ?? 1);
            const order = (query.sort && ORDER[query.sort]) || (caps.website ? ORDER.relevance : ORDER.name);
            const [templates, total] = await Promise.all([
                client.searchRead<Template>('product.template', domain, templateFields(caps), { limit: pageSize, offset: (page - 1) * pageSize, order }),
                client.searchCount('product.template', domain)
            ]);
            return { items: await build(templates, caps), total, page, pageSize };
        },

        async listCollections(): Promise<CatalogCollection[]> {
            const caps = await capabilities();
            const rows = await client.searchRead<{ id: number; name: string; parent_id: Many2one }>(caps.categoryModel, [], ['id', 'name', 'parent_id'], { order: 'id asc' });
            return rows.map((row) => ({ id: String(row.id), slug: collectionSlug(row.name, row.id), title: row.name, parentId: row.parent_id ? String(row.parent_id[0]) : undefined }));
        },

        async getCollection(slug) {
            const caps = await capabilities();
            const id = collectionId(slug);
            if (!Number.isFinite(id)) return null;
            const [row] = await client.searchRead<{ id: number; name: string; parent_id: Many2one }>(caps.categoryModel, [['id', '=', id]], ['id', 'name', 'parent_id'], { limit: 1 });
            return row ? { id: String(row.id), slug: collectionSlug(row.name, row.id), title: row.name, parentId: row.parent_id ? String(row.parent_id[0]) : undefined } : null;
        },

        async listSummaries({ page, pageSize }): Promise<CatalogSummaryPage> {
            const caps = await capabilities();
            const domain = published(caps);
            const [rows, total] = await Promise.all([
                client.searchRead<Template>('product.template', domain, ['id', 'name', 'default_code', 'write_date'], { limit: pageSize, offset: (page - 1) * pageSize, order: 'id asc' }),
                client.searchCount('product.template', domain)
            ]);
            return {
                items: rows.map((row) => ({ slug: odooSlug(row.name, referenceOf(row)), updatedAt: row.write_date ? `${row.write_date.replace(' ', 'T')}Z` : undefined })),
                total
            };
        }
    };
}
