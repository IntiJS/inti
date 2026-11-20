#!/usr/bin/env node
/**
 * Checks @intijs/adapter-odoo against a real Odoo.
 *
 * It starts a throwaway Odoo in Docker (its own project, network, volumes and port), installs
 * sale_management, stock and website_sale, creates an API key, products, variants, a tax and
 * stock, and walks through what a shop built with Inti does: list, filter, read by reference,
 * prices with taxes, free stock, images through the proxy, an order, the JSON-RPC fallback and a
 * key rotation. It is destroyed at the end.
 *
 * Usage: node scripts/odoo-check.mjs [19|20] [--keep]
 *        Requires Docker and `npm run build`.
 */

import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = join(ROOT, 'scripts/odoo-check/docker-compose.yml');
const ENDPOINT = 'http://127.0.0.1:43590';
const DATABASE = 'inti';
const version = process.argv.find((arg) => /^\d+$/.test(arg)) ?? '19';
const keep = process.argv.includes('--keep');
const env = { ...process.env, ODOO_VERSION: version };

const compose = (args, input) =>
    execFileSync('docker', ['compose', '-f', COMPOSE, ...args], { encoding: 'utf8', env, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

const results = [];
async function check(name, run) {
    try {
        await run();
        results.push({ name, ok: true });
        console.log(`✓ ${name}`);
    } catch (error) {
        results.push({ name, ok: false });
        console.log(`✗ ${name}\n    ${error instanceof Error ? error.message : error}`);
    }
}

function equal(actual, expected, label = 'value') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

/** Runs Python in `odoo shell` against the check's database and returns what it prints */
function shell(code) {
    return compose(['run', '--rm', '-T', 'odoo', 'odoo', 'shell', '-d', DATABASE, '--no-http'], code);
}

/**
 * Is Odoo answering? With node:http and a time limit: while Odoo boots, Docker's port proxy
 * accepts the connection and drops it, and fetch (undici) can hang on that forever.
 */
function probe(url) {
    return new Promise((resolve) => {
        const request = get(url, { timeout: 3000 }, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(false));
    });
}

async function waitForOdoo() {
    for (let i = 0; i < 120; i++) {
        if (await probe(`${ENDPOINT}/web/login`)) return;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Odoo did not start:
${compose(['logs', 'odoo', '--tail', '30'])}`);
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function main() {
    console.log(`\n=== Odoo ${version} ===`);
    const step = (text) => console.log(`  · ${text}`);
    step('database');
    compose(['up', '-d', '--wait', 'db']);
    step('installing sale_management, stock and website_sale');
    compose(['run', '--rm', 'odoo', 'odoo', '-d', DATABASE, '-i', 'sale_management,stock,website_sale', '--stop-after-init', '--without-demo=True']);

    step('creating an API key');
    const keyOutput = shell(`
from datetime import datetime, timedelta
params = env['ir.config_parameter'].sudo()
# Odoo 20 has typed setters (set_bool); 19 has set_param
(params.set_bool if hasattr(params, 'set_bool') else params.set_param)('base.enable_programmatic_api_keys', True)
admin = env.ref('base.user_admin')
key = env['res.users.apikeys'].with_user(admin)._generate('rpc', 'inti-check', datetime.now() + timedelta(days=30))
env.cr.commit()
print('KEY=' + key)
`);
    const apiKey = keyOutput.match(/KEY=(\S+)/)?.[1];
    if (!apiKey) throw new Error(`no API key:\n${keyOutput.slice(-1500)}`);

    step('starting Odoo');
    compose(['up', '-d', 'odoo']);
    await waitForOdoo();
    step('creating products, variants, a tax and stock');

    const odoo = await import(pathToFileURL(join(ROOT, 'packages/adapter-odoo/dist/index.js')).href);
    const { createCacheManager } = await import(pathToFileURL(join(ROOT, 'packages/core/dist/cache/index.js')).href);
    const client = odoo.createOdooClient({ url: ENDPOINT, database: DATABASE, apiKey });

    // ---------- the shop's data, as an employee would enter it ----------
    const create = async (model, values, context) => {
        const ids = await client.call(model, 'create', { vals_list: [values] }, { context });
        return Array.isArray(ids) ? ids[0] : ids;
    };
    const caps = await odoo.detectOdoo(client);
    const storable = caps.storableField === 'is_storable' ? { is_storable: true } : { detailed_type: 'product' };

    let taxId;
    try {
        taxId = await create('account.tax', { name: 'VAT 21% (inti check)', amount: 21, amount_type: 'percent', type_tax_use: 'sale' });
    } catch (error) {
        console.log(`    (no tax: ${error.message.slice(0, 160)})`);
    }
    const taxes = taxId ? { taxes_id: [[6, 0, [taxId]]] } : { taxes_id: [[6, 0, []]] };

    const sizeId = await create('product.attribute', { name: 'Size', create_variant: 'always' });
    const small = await create('product.attribute.value', { name: 'S', attribute_id: sizeId });
    const medium = await create('product.attribute.value', { name: 'M', attribute_id: sizeId });
    const shirtId = await create('product.template', {
        name: 'Blue Shirt',
        list_price: 100,
        sale_ok: true,
        is_published: true,
        ...storable,
        ...taxes,
        attribute_line_ids: [[0, 0, { attribute_id: sizeId, value_ids: [[6, 0, [small, medium]]] }]]
    });
    const shirtVariants = await client.searchRead('product.product', [['product_tmpl_id', '=', shirtId]], ['id', 'product_template_attribute_value_ids']);
    for (const [index, variant] of shirtVariants.entries()) {
        await client.call('product.product', 'write', { vals: { default_code: `SH-001-${index === 0 ? 'S' : 'M'}` } }, { ids: [variant.id] });
    }
    const mugId = await create('product.template', {
        name: 'Mug',
        default_code: 'MUG-1',
        list_price: 10,
        sale_ok: true,
        is_published: true,
        image_1920: PNG,
        ...storable,
        ...taxes
    });
    const secretId = await create('product.template', { name: 'Secret', default_code: 'SEC-1', list_price: 5, sale_ok: true, is_published: false, image_1920: PNG });

    const [mugVariant] = await client.searchRead('product.product', [['product_tmpl_id', '=', mugId]], ['id']);
    const [warehouse] = await client.searchRead('stock.warehouse', [], ['lot_stock_id'], { limit: 1 });
    const quant = await create('stock.quant', { product_id: mugVariant.id, location_id: warehouse.lot_stock_id[0], inventory_quantity: 5 }, { inventory_mode: true });
    await client.call('stock.quant', 'action_apply_inventory', {}, { ids: [quant], context: { inventory_mode: true } });

    const source = odoo.odooCatalogSource({ client });
    const priceWithTax = (amount) => (taxId ? Math.round(amount * 121) / 100 : amount);

    // ---------- checks ----------
    await check(`JSON-2 is used on Odoo ${version}`, async () => {
        await client.searchCount('product.template', []);
        equal(client.protocol, 'json2', 'protocol');
    });

    await check('detection: stock, website, storable flag and the tax flag are found by their fields', async () => {
        equal({ stock: caps.stock, website: caps.website, storable: caps.storableField !== null }, { stock: true, website: true, storable: true }, 'capabilities');
    });

    await check('the list has the published products and not the unpublished one', async () => {
        const page = await source.list({ pageSize: 50, sort: 'name' });
        const titles = page.items.map((item) => item.title);
        if (!titles.includes('Blue Shirt') || !titles.includes('Mug')) throw new Error(`missing products: ${titles}`);
        if (titles.includes('Secret')) throw new Error('an unpublished product is listed');
        equal(page.total >= 2, true, 'total');
    });

    await check('a product is read by its internal reference, with tax-included price and free stock', async () => {
        const mug = await source.getItem(odoo.odooSlug('Mug', 'MUG-1'));
        equal(mug?.id, 'MUG-1', 'id');
        equal(mug?.price?.amount, priceWithTax(10), 'price');
        equal({ quantity: mug?.quantity, availability: mug?.availability }, { quantity: 5, availability: 'InStock' }, 'stock');
    });

    await check('without taxes, the price is the stored one', async () => {
        const net = odoo.odooCatalogSource({ client, taxes: 'excluded' });
        equal((await net.getItem('MUG-1'))?.price?.amount, 10, 'price');
    });

    await check("a variant's reference finds its product, with every variant and its options", async () => {
        const shirt = await source.getItem('SH-001-M');
        equal(shirt?.title, 'Blue Shirt', 'title');
        equal(shirt?.variants?.map((variant) => [variant.sku, variant.options.Size]).sort(), [['SH-001-M', 'M'], ['SH-001-S', 'S']], 'variants');
        equal(shirt?.availability, 'OutOfStock', 'availability');
    });

    await check('an unpublished product is not found, even by reference', async () => {
        equal(await source.getItem('SEC-1'), null, 'item');
    });

    await check('filters: in stock and by attribute value', async () => {
        const inStock = await source.list({ inStock: true, pageSize: 50 });
        const titles = inStock.items.map((item) => item.title);
        if (!titles.includes('Mug') || titles.includes('Blue Shirt')) throw new Error(`in stock: ${titles}`);
        const medium = await source.list({ filters: { Size: ['M'] }, pageSize: 50 });
        equal(medium.items.map((item) => item.title), ['Blue Shirt'], 'size M');
    });

    await check('the sitemap enumerates by reference', async () => {
        const { items, total } = await source.listSummaries({ page: 1, pageSize: 100 });
        if (!items.some((item) => item.slug.endsWith('--MUG-1'))) throw new Error('MUG-1 missing');
        equal(total >= 2, true, 'total');
    });

    await check('the image proxy serves a published product and refuses an unpublished one', async () => {
        const route = odoo.odooImageRoute({ client });
        const get = (id) =>
            route({ params: { model: 'product.template', id: String(id), size: 'image_128' }, request: new Request(`https://site.test/media/odoo/product.template/${id}/image_128?v=1`) });
        const ok = await get(mugId);
        equal({ status: ok.status, type: ok.headers.get('content-type') }, { status: 200, type: 'image/png' }, 'published');
        equal(ok.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'cache');
        equal((await get(secretId)).status, 404, 'unpublished');
    });

    await check("Odoo's change notice purges the product and the listings", async () => {
        const cache = createCacheManager();
        const route = odoo.odooPurgeRoute({ cache, token: 't0ken' });
        const post = (token) =>
            route({ request: new Request(`https://site.test/api/odoo/purge?token=${token}`, { method: 'POST', body: JSON.stringify({ _model: 'product.template', _id: mugId, default_code: 'MUG-1' }) }) });
        equal((await post('wrong')).status, 401, 'wrong token');
        equal((await (await post('t0ken')).json()).purged, ['catalog:odoo:lists', 'catalog:odoo:item:MUG-1'], 'tags');
    });

    await check('an order from the site is priced by Odoo, and refuses what is not for sale', async () => {
        const order = await odoo.createOdooOrder(client, { customer: { email: 'buyer@example.invalid', name: 'Buyer' }, lines: [{ reference: 'MUG-1', quantity: 2 }] });
        if (!/^S\d+/.test(order.name)) throw new Error(`order name ${order.name}`);
        equal(order.total, priceWithTax(20), 'total');
        const refused = await odoo.createOdooOrder(client, { customer: { email: 'b@example.invalid', name: 'B' }, lines: [{ reference: 'SEC-1', quantity: 1 }] }).catch((e) => e);
        if (!(refused instanceof Error) || !/Not for sale/.test(refused.message)) throw new Error('an unpublished product was ordered');
    });

    await check('JSON-RPC works as the fallback, with the login', async () => {
        const rpc = odoo.createOdooClient({ url: ENDPOINT, database: DATABASE, apiKey, protocol: 'jsonrpc', login: 'admin' });
        equal((await rpc.searchCount('product.template', [['default_code', '=', 'MUG-1']])) , 1, 'count');
    });

    await check('a key is rotated: the new one works and the old one is refused', async () => {
        let current = apiKey;
        const store = { current: () => current, save: (key) => void (current = key) };
        const rotating = odoo.createOdooClient({ url: ENDPOINT, database: DATABASE, apiKey: store });
        await odoo.rotateOdooKey(rotating, store, { days: 30, name: 'inti-check-rotated' });
        if (current === apiKey) throw new Error('the key did not change');
        equal(await rotating.searchCount('product.template', [['default_code', '=', 'MUG-1']]), 1, 'new key');
        const old = odoo.createOdooClient({ url: ENDPOINT, database: DATABASE, apiKey });
        const error = await old.searchCount('product.template', []).catch((e) => e);
        if (!(error instanceof Error) || !/401|403/.test(error.message)) throw new Error(`the old key still works: ${error}`);
    });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks against a real Odoo ${version}`);
    if (failed.length) process.exitCode = 1;
}

// Node exits quietly when nothing is left to wait on: say so instead of passing
process.on('exit', (code) => {
    if (code === 0 && results.length === 0) {
        console.error('✗ the check ended before running any check');
        process.exitCode = 1;
    }
});

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => {
        if (!keep) compose(['down', '-v']);
    });
