import type { IntiConfig } from './types/index.js';

/**
 * Typed identity for `inti.config.ts`.
 *
 * It lives in a module with no dependencies because it is exported from the
 * root of `@intijs/core`, which Astro loads from `astro.config.mjs` before
 * its virtual modules exist: it cannot pull in anything that imports
 * `astro:actions`.
 *
 * It used to be exported only from `@intijs/core/index`, while all the
 * documentation imported it from `@intijs/core`. `VisualBridgeAuto` loads
 * `inti.config.ts` inside a try/catch, so the undefined `defineConfig`
 * made the configuration be ignored without any warning.
 */
export function defineConfig(config: IntiConfig): IntiConfig {
    return config;
}
