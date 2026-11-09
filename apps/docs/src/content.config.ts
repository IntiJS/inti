import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/**
 * Without this file Starlight finds no entries and the site builds
 * without errors but with zero pages: only a 404. Astro 5 stopped
 * discovering `src/content/` by convention, so the collection has to
 * be declared.
 */
export const collections = {
    docs: defineCollection({ loader: docsLoader(), schema: docsSchema() })
};
