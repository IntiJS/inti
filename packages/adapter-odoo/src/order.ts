/**
 * A simple order, straight from the site to Odoo ("direct mode").
 *
 * The visitor sends who they are and what they want (references and quantities); Odoo prices it.
 * Nothing the browser sends decides a price, a discount or a tax: the order lines only carry the
 * product and the quantity, and Odoo computes the rest with its own price lists. The result is a
 * quotation (`sale.order` in draft) the shop follows up in Odoo; `confirm: true` confirms it.
 *
 *   // src/actions/index.ts
 *   import { defineAction } from 'astro:actions';
 *   import { z } from 'astro:schema';
 *   export const server = {
 *       order: defineAction({ input: z.object({ … }), handler: (input) => createOdooOrder(client, input) })
 *   };
 *
 * The action is public: put a rate limit and a bot check in front of it, as for any form.
 */

import type { OdooClient } from './client.js';

export interface OrderInput {
    customer: { email: string; name: string; phone?: string; street?: string; city?: string; zip?: string; countryCode?: string };
    /** Variant references (`default_code`) and quantities */
    lines: Array<{ reference: string; quantity: number }>;
    note?: string;
}

export interface OrderResult {
    id: number;
    /** `S00042`, what the customer is told */
    name: string;
    total: number;
    currency?: string;
}

export interface OrderOptions {
    /** Confirm the quotation (it becomes a sales order). Default false */
    confirm?: boolean;
    /** Most lines in one order. Default 50 */
    maxLines?: number;
    /** Most units of one line. Default 999 */
    maxQuantity?: number;
    /** Written in the order's `origin`. Default `Website (Inti)` */
    origin?: string;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Refuses what cannot become a sensible order, before anything reaches Odoo */
export function validateOrder(input: OrderInput, options: OrderOptions = {}): string | null {
    const maxLines = options.maxLines ?? 50;
    const maxQuantity = options.maxQuantity ?? 999;
    if (!input?.customer || !EMAIL.test(String(input.customer.email ?? ''))) return 'A valid email is required.';
    if (!String(input.customer.name ?? '').trim() || String(input.customer.name).length > 200) return 'A name is required.';
    if (!Array.isArray(input.lines) || input.lines.length === 0) return 'The order has no lines.';
    if (input.lines.length > maxLines) return `An order has at most ${maxLines} lines.`;
    for (const line of input.lines) {
        if (typeof line?.reference !== 'string' || !line.reference.trim() || line.reference.length > 100) return 'Every line needs a product reference.';
        if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > maxQuantity) return `Quantities go from 1 to ${maxQuantity}.`;
    }
    if (input.note !== undefined && String(input.note).length > 2000) return 'The note is too long.';
    return null;
}

export async function createOdooOrder(client: OdooClient, input: OrderInput, options: OrderOptions = {}): Promise<OrderResult> {
    const problem = validateOrder(input, options);
    if (problem) throw new Error(problem);

    // Each reference has to be a product the shop sells
    const references = [...new Set(input.lines.map((line) => line.reference.trim()))];
    // With a web shop, only what it publishes can be ordered from the site
    const website = 'is_published' in (await client.fieldsGet('product.template', ['type']));
    const products = await client.searchRead<{ id: number; default_code: string }>(
        'product.product',
        [
            ['default_code', 'in', references],
            ['sale_ok', '=', true],
            ...(website ? ([['product_tmpl_id.is_published', '=', true]] as Array<[string, string, unknown]>) : [])
        ],
        ['id', 'default_code']
    );
    const byReference = new Map(products.map((product) => [product.default_code, product.id]));
    const missing = references.filter((reference) => !byReference.has(reference));
    if (missing.length) throw new Error(`Not for sale: ${missing.join(', ')}`);

    // The customer: found by email, or created
    const email = input.customer.email.trim().toLowerCase();
    const [existing] = await client.searchRead<{ id: number }>('res.partner', [['email', '=ilike', email]], ['id'], { limit: 1 });
    let partnerId = existing?.id;
    if (!partnerId) {
        let countryId: number | undefined;
        if (input.customer.countryCode) {
            const [country] = await client.searchRead<{ id: number }>('res.country', [['code', '=', input.customer.countryCode.toUpperCase()]], ['id'], { limit: 1 });
            countryId = country?.id;
        }
        const created = await client.call<number[] | number>('res.partner', 'create', {
            vals_list: [
                {
                    name: input.customer.name.trim(),
                    email,
                    ...(input.customer.phone ? { phone: input.customer.phone } : {}),
                    ...(input.customer.street ? { street: input.customer.street } : {}),
                    ...(input.customer.city ? { city: input.customer.city } : {}),
                    ...(input.customer.zip ? { zip: input.customer.zip } : {}),
                    ...(countryId ? { country_id: countryId } : {})
                }
            ]
        });
        partnerId = Array.isArray(created) ? created[0] : created;
    }

    const created = await client.call<number[] | number>('sale.order', 'create', {
        vals_list: [
            {
                partner_id: partnerId,
                origin: options.origin ?? 'Website (Inti)',
                ...(input.note ? { note: String(input.note) } : {}),
                // (0, 0, values): a new line. Only product and quantity: Odoo prices it
                order_line: input.lines.map((line) => [0, 0, { product_id: byReference.get(line.reference.trim()), product_uom_qty: line.quantity }])
            }
        ]
    });
    const orderId = Array.isArray(created) ? created[0] : created;

    if (options.confirm) await client.call('sale.order', 'action_confirm', {}, { ids: [orderId] });

    const [order] = await client.read<{ id: number; name: string; amount_total: number; currency_id: [number, string] | false }>(
        'sale.order',
        [orderId],
        ['id', 'name', 'amount_total', 'currency_id']
    );
    return { id: order.id, name: order.name, total: order.amount_total, currency: order.currency_id ? order.currency_id[1] : undefined };
}
