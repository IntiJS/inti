/**
 * Strapi SEO metadata.
 *
 * The official SEO plugin adds a `shared.seo` component with stable names
 * (`metaTitle`, `metaDescription`, `metaImage`, `metaSocial`,
 * `canonicalURL`, `metaRobots`, `structuredData`), so those are read
 * directly. Projects that modelled their own component usually keep the
 * same names or a close variant.
 */

import { asImageUrl, extractSeo, mergeSeo } from '@intijs/core/seo';
import type { PageSeo } from '@intijs/core/types';

/** `metaRobots` comes as free text: 'noindex, nofollow' */
function parseMetaRobots(value: unknown): PageSeo['robots'] {
    if (typeof value !== 'string' || !value.trim()) return undefined;

    const normalized = value.toLowerCase();
    const robots: NonNullable<PageSeo['robots']> = {};

    if (normalized.includes('noindex')) robots.index = false;
    if (normalized.includes('nofollow')) robots.follow = false;

    return Object.keys(robots).length > 0 ? robots : undefined;
}

/**
 * `metaSocial` is a list of entries per network:
 * `[{ socialNetwork: 'Facebook', title, description, image }]`
 */
function parseMetaSocial(entries: unknown): Pick<PageSeo, 'openGraph' | 'twitter'> {
    if (!Array.isArray(entries)) return {};

    const find = (network: string) =>
        entries.find(
            (entry: any) => typeof entry?.socialNetwork === 'string' && entry.socialNetwork.toLowerCase() === network
        );

    const facebook: any = find('facebook');
    const twitter: any = find('twitter') ?? find('x');

    const shape = (entry: any) =>
        entry
            ? {
                  title: entry.title || undefined,
                  description: entry.description || undefined,
                  image: asImageUrl(entry.image)
              }
            : undefined;

    return { openGraph: shape(facebook), twitter: shape(twitter) };
}

/**
 * Extracts the SEO from the attributes of a Strapi entry.
 *
 * Works the same in v4 (with `attributes`) and v5 (flat), because it receives
 * the attributes already normalized by the adapter.
 */
export function extractStrapiSeo(attributes: any): PageSeo | undefined {
    if (!attributes) return undefined;

    const seo = attributes.seo;
    const social = parseMetaSocial(seo?.metaSocial);

    const fromPlugin: PageSeo | undefined = seo
        ? {
              title: seo.metaTitle || undefined,
              description: seo.metaDescription || undefined,
              image: asImageUrl(seo.metaImage),
              canonical: seo.canonicalURL || undefined,
              keywords:
                  typeof seo.keywords === 'string' && seo.keywords.trim()
                      ? seo.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
                      : undefined,
              robots: parseMetaRobots(seo.metaRobots),
              openGraph: social.openGraph,
              twitter: social.twitter,
              jsonLd: seo.structuredData ?? undefined,
              source: 'strapi-seo'
          }
        : undefined;

    // Loose fields on the entry itself, for models that do not use the plugin
    const fromEntry = extractSeo(
        attributes,
        {
            title: ['metaTitle', 'seoTitle', 'title'],
            description: ['metaDescription', 'seoDescription', 'description'],
            image: ['metaImage', 'ogImage', 'cover'],
            canonical: ['canonicalURL', 'canonical'],
            publishedAt: ['publishedAt'],
            modifiedAt: ['updatedAt'],
            locale: ['locale']
        },
        'strapi'
    );

    return mergeSeo(fromPlugin, fromEntry);
}
