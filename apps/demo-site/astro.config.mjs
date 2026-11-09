import { defineConfig } from 'astro/config';
import { intiStyles } from '@intijs/core';
import node from '@astrojs/node';

export default defineConfig({
  server: {
    port: 4330,
  },
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  integrations: [intiStyles()],
  devToolbar: {
    enabled: true
  }
});
