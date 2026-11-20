import { describe, test, expect } from 'bun:test';
import {
    createOdooClient,
    applyTaxes,
    odooSlug,
    referenceFromSlug,
    parseOdooNotice,
    validateOrder,
    sniffImage,
    envKeyStore,
    rotateIfExpiring
} from '../src/index.js';

type Call = { url: string; headers: Record<string, string>; body: any };

function server(handler: (call: Call) => { status?: number; body?: unknown }) {
    const calls: Call[] = [];
    const fetch = (async (input: string, init: RequestInit = {}) => {
        const call = { url: String(input), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const result = handler(call);
        return new Response(JSON.stringify(result.body ?? null), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
}

describe('client', () => {
    test('JSON-2: the method by URL, arguments by name, bearer key and database header', async () => {
        const odoo = server(() => ({ body: [{ id: 1 }] }));
        const client = createOdooClient({ url: 'https://erp.test/', database: 'shop', apiKey: 'k1', fetch: odoo.fetch, context: { lang: 'es_ES' } });
        await client.searchRead('product.template', [['sale_ok', '=', true]], ['name'], { limit: 5 });
        expect(odoo.calls[0].url).toBe('https://erp.test/json/2/product.template/search_read');
        expect(odoo.calls[0].headers.Authorization).toBe('bearer k1');
        expect(odoo.calls[0].headers['X-Odoo-Database']).toBe('shop');
        expect(odoo.calls[0].body).toEqual({ domain: [['sale_ok', '=', true]], fields: ['name'], limit: 5, offset: 0, context: { lang: 'es_ES' } });
        expect(client.protocol).toBe('json2');
    });

    test('an Odoo without JSON-2 (404) falls back to JSON-RPC with the login, once', async () => {
        const odoo = server((call) => {
            if (call.url.includes('/json/2/')) return { status: 404, body: { message: 'not found' } };
            if (call.body.params.service === 'common') return { body: { result: 7 } };
            return { body: { result: 3 } };
        });
        const client = createOdooClient({ url: 'https://erp.test', database: 'shop', apiKey: 'k1', login: 'shop@example.test', fetch: odoo.fetch });
        expect(await client.searchCount('product.template', [])).toBe(3);
        expect(await client.searchCount('product.template', [])).toBe(3);
        expect(client.protocol).toBe('jsonrpc');
        const rpc = odoo.calls.filter((call) => call.url.endsWith('/jsonrpc'));
        expect(rpc[0].body.params.args).toEqual(['shop', 'shop@example.test', 'k1', {}]);
        expect(rpc[1].body.params.args.slice(0, 5)).toEqual(['shop', 7, 'k1', 'product.template', 'search_count']);
        expect(odoo.calls.filter((call) => call.url.includes('/json/2/'))).toHaveLength(1);
    });

    test('a refused key switches to the next one, and the call is tried again', async () => {
        const odoo = server((call) => (call.headers.Authorization === 'bearer old' ? { status: 401, body: { message: 'Invalid apikey' } } : { body: 4 }));
        const vars: Record<string, string> = { INTI_ODOO_API_KEY: 'old', INTI_ODOO_API_KEY_NEXT: 'new' };
        const client = createOdooClient({ url: 'https://erp.test', apiKey: envKeyStore((name) => vars[name]), fetch: odoo.fetch });
        expect(await client.searchCount('product.template', [])).toBe(4);
        expect(odoo.calls.map((call) => call.headers.Authorization)).toEqual(['bearer old', 'bearer new']);
    });

    test("Odoo's own message ends up in the error", async () => {
        const odoo = server(() => ({ status: 422, body: { name: 'odoo.exceptions.ValidationError', message: 'Invalid field foo' } }));
        const client = createOdooClient({ url: 'https://erp.test', apiKey: 'k', fetch: odoo.fetch });
        const error = await client.call('product.template', 'write', {}).catch((e) => e);
        expect(String(error.message)).toContain('Invalid field foo');
    });
});

describe('keys', () => {
    test('rotateIfExpiring rotates only inside the window, storing before revoking', async () => {
        const steps: string[] = [];
        const store = { current: () => 'old', save: (key: string) => void steps.push(`save ${key}`), expiresAt: () => new Date('2026-12-01T00:00:00Z') };
        const client = {
            call: async (_model: string, method: string, kwargs: any) => {
                steps.push(`${method} ${kwargs.key}`);
                return method === 'generate' ? 'new' : true;
            }
        } as any;
        expect((await rotateIfExpiring(client, store, { now: new Date('2026-11-01T00:00:00Z') })).rotated).toBe(false);
        expect((await rotateIfExpiring(client, store, { now: new Date('2026-11-25T00:00:00Z') })).rotated).toBe(true);
        expect(steps).toEqual(['generate old', 'save new', 'revoke old']);
    });
});

describe('catalog helpers', () => {
    test('a slug is readable and carries the internal reference', () => {
        expect(odooSlug('Camiseta Azul Ñ', 'SH/001')).toBe('camiseta-azul-n--SH%2F001');
        expect(referenceFromSlug('camiseta-azul-n--SH%2F001')).toBe('SH/001');
        expect(referenceFromSlug('MUG-1')).toBe('MUG-1');
    });

    test('taxes: added to a net price, taken out of an included one', () => {
        const vat = { id: 1, amount: 21, amount_type: 'percent' };
        expect(applyTaxes(100, [vat], 'included', 'price_include')).toBe(121);
        expect(applyTaxes(121, [{ ...vat, price_include: true }], 'excluded', 'price_include')).toBe(100);
        expect(applyTaxes(121, [{ ...vat, price_include_override: 'tax_included' }], 'included', 'price_include_override')).toBe(121);
        expect(applyTaxes(100, [{ id: 2, amount: 2, amount_type: 'fixed' }], 'included', null)).toBe(102);
    });

    test("Odoo's webhook body: by reference, else by template id, else everything", () => {
        expect(parseOdooNotice({ _model: 'product.template', _id: 4, default_code: 'MUG-1' })).toEqual({ ids: ['MUG-1'] });
        expect(parseOdooNotice({ _model: 'product.template', _id: 4 })).toEqual({ ids: ['tmpl-4'] });
        expect(parseOdooNotice({ _model: 'stock.quant', _id: 9 })).toEqual({ ids: [] });
    });

    test('an order is refused before reaching Odoo when it makes no sense', () => {
        const customer = { email: 'a@b.co', name: 'A' };
        expect(validateOrder({ customer, lines: [{ reference: 'X', quantity: 1 }] })).toBeNull();
        expect(validateOrder({ customer: { email: 'nope', name: 'A' }, lines: [{ reference: 'X', quantity: 1 }] })).toContain('email');
        expect(validateOrder({ customer, lines: [{ reference: 'X', quantity: 0 }] })).toContain('Quantities');
        expect(validateOrder({ customer, lines: [] })).toContain('no lines');
    });

    test('the image proxy only serves real raster images', () => {
        expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
        expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    });
});
