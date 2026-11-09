/**
 * Inti Astro Integration
 *
 * Entry point for: import inti from '@intijs/core'
 *
 * @example
 * ```js
 * // astro.config.mjs
 * import { defineConfig } from 'astro/config';
 * import inti, { intiStyles } from '@intijs/core';
 *
 * export default defineConfig({
 *   integrations: [inti(), intiStyles()]
 * });
 * ```
 *
 * Only what is used INSIDE astro.config.mjs is exported from here.
 * This module is loaded before Astro's virtual modules exist, so it
 * cannot reach anything that imports `astro:actions` or `astro:db` —
 * that is why `intiActions` lives in `@intijs/core/actions`.
 */
export { default } from './dist/integration/index.js';
export { intiStyles } from './dist/integrations/inti-styles.js';
export { defineConfig } from './dist/config.js';
