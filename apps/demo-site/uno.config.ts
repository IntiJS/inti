import { defineConfig } from 'unocss'
import presetWind from '@unocss/preset-wind'

export default defineConfig({
    presets: [
        presetWind(),
    ],
    content: {
        pipeline: {
            include: [
                // Include local components
                /\.(vue|svelte|[jt]sx|mdx?|astro|elm|php|phtml|html)($|\?)/,
                // Include core framework components
                /.*\/@intijs\/core\/.*\.(astro|js|ts|mjs|cjs)/,
            ],
        }
    }
})
