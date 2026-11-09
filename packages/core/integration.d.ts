/**
 * Inti Astro Integration
 *
 * Mirrors exactly what `integration.js` exports. It used to be maintained by
 * hand and had drifted: it declared neither `intiStyles` nor the
 * integration's options.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import { defineConfig } from 'astro/config';
 * import inti from '@intijs/core';
 *
 * export default defineConfig({
 *   integrations: [inti()]
 * });
 * ```
 */
export { default } from './dist/integration/index.js';
export type { IntiIntegrationOptions } from './dist/integration/index.js';
export { intiStyles } from './dist/integrations/inti-styles.js';
export { defineConfig } from './dist/config.js';
