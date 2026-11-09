import { defineConfig } from '@intijs/core';

export default defineConfig({
    adapter: 'kitsuden',
    adapterConfig: {
        endpoint: process.env.KITSUDEN_API_URL ?? 'http://localhost:3000',
        // Only needed for writes: reading published pages is public.
        // It must be an agent key (kitsuden_agent_…).
        token: process.env.KITSUDEN_API_TOKEN
    },
    collections: ['pages'],
    outputDir: './src/lib/inti'
});
