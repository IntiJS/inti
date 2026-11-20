/**
 * `@intijs/adapter-odoo`: an Odoo catalog for Astro sites built with Inti.
 *
 * Odoo is not a page CMS here: pages stay in the site's CMS (or the local store), and Odoo is
 * the catalog next to it, read through `@intijs/core/catalog`.
 */

export { createOdooClient } from './client.js';
export type { OdooClient, OdooClientOptions, OdooDomain, CallOptions } from './client.js';
export { staticKey, envKeyStore, rotateOdooKey, rotateIfExpiring } from './keys.js';
export type { OdooKeyStore, RotateOptions } from './keys.js';
export { detectOdoo } from './detect.js';
export type { OdooCapabilities } from './detect.js';
export { odooCatalogSource, odooSlug, referenceFromSlug, referenceOf, applyTaxes, slugify } from './source.js';
export type { OdooCatalogOptions } from './source.js';
export { odooImageRoute, sniffImage, binaryContent } from './images.js';
export type { OdooImageRouteOptions } from './images.js';
export { odooPurgeRoute, parseOdooNotice } from './purge.js';
export type { OdooPurgeOptions, OdooNotice } from './purge.js';
export { createOdooOrder, validateOrder } from './order.js';
export type { OrderInput, OrderOptions, OrderResult } from './order.js';
