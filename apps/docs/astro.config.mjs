import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  // Public URL where THIS documentation is deployed. The sitemap and canonicals
  // are built from it, so it is set at deploy time and never made up.
  site: process.env.DOCS_SITE,
  integrations: [
    starlight({
      title: 'Inti.js',
      tagline: 'AI for any CMS, without changing the CMS',
      logo: {
        src: './src/assets/inti-logo.svg',
        replacesTitle: true,
      },
      social: {
        github: 'https://github.com/intijs/inti',
      },
      sidebar: [
        {
          label: 'Core Concepts',
          items: [
            { label: 'Overview', link: '/core/overview/' },
            { label: 'Block Orchestrator', link: '/core/block-orchestrator/' },
            { label: 'Architecture', link: '/core/architecture/' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Installation', link: '/guides/installation/' },
            { label: 'Runtime Compatibility', link: '/guides/runtimes/' },
            { label: 'Configuration', link: '/guides/configuration/' },
            { label: 'First Project', link: '/guides/quickstart/' },
            { label: 'Securing Writes', link: '/guides/securing-writes/' },
            { label: 'Deployment', link: '/guides/deployment/' },
            { label: 'Working with AI', link: '/guides/ai-optimization/' },
            { label: 'WooCommerce', link: '/guides/woocommerce/' },
            { label: 'Drafts and Undo', link: '/guides/drafts/' },
            { label: 'Personalization', link: '/guides/personalization/' },
            { label: 'Generative UI', link: '/guides/generative-ui/' },
            { label: 'Deploying to Cloudflare', link: '/guides/cloudflare/' },
          ],
        },
        {
          label: 'CLI',
          items: [
            { label: 'inti sync', link: '/cli/sync/' },
            { label: 'Type Generation', link: '/cli/typegen/' },
          ],
        },
        {
          label: 'Registry',
          items: [
            { label: 'BlockRenderer', link: '/registry/block-renderer/' },
            { label: 'Component Registry', link: '/registry/components/' },
            { label: 'Client Directives', link: '/registry/client-directives/' },
          ],
        },
        {
          label: 'Adapters',
          items: [
            { label: 'The Contract', link: '/adapters/contract/' },
            { label: 'Creating an Adapter', link: '/adapters/creating/' },
            { label: 'Kitsuden', link: '/adapters/kitsuden/' },
            { label: 'Keystatic', link: '/adapters/keystatic/' },
            { label: 'Introspection', link: '/adapters/introspection/' },
          ],
        },
      ],
      customCss: [
        './src/styles/custom.css',
      ],
      editLink: {
        baseUrl: 'https://github.com/intijs/inti/edit/main/apps/docs/',
      },
    }),
  ],
  // Hybrid rendering for the documentation
  output: 'static',
});
