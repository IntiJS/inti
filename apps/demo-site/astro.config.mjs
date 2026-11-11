import { defineConfig } from 'astro/config';
import { intiStyles } from '@intijs/core';
import node from '@astrojs/node';

// Two builds from the same project:
// - the default: a server build with the Node adapter (what `npm run build` and CI make);
// - with INTI_PAGES=1: a static build of the landing page for GitHub Pages, served at
//   https://intijs.github.io/inti/ (see .github/workflows/pages.yml). It has no adapter,
//   so nothing server-only can be part of it.
const pages = process.env.INTI_PAGES === '1';

export default defineConfig({
  server: {
    port: 4330,
  },
  ...(pages
    ? {
        output: 'static',
        site: 'https://intijs.github.io',
        base: '/inti',
      }
    : {
        output: 'server',
        adapter: node({ mode: 'middleware' }),
      }),
  integrations: [intiStyles()],
  devToolbar: {
    enabled: true
  }
});
