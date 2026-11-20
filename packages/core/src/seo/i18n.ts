/**
 * Languages in the URL: `/en/about` is the English `about`, `/about` the
 * default language's.
 *
 *   const { locale, slug } = localeFromPath(Astro.url.pathname, { locales: ['es', 'en'], defaultLocale: 'es' });
 *   const page = await adapter.fetchPageBySlug(slug, { locale });
 *
 * The CMS keeps the translations (WPML, Polylang, Strapi's i18n, Kitsuden's
 * locales); this only reads which one the visitor asked for.
 */

export interface LocaleRouting {
    /** Every language the site has, BCP 47 */
    locales: string[];
    defaultLocale: string;
    /** `/es/about` instead of `/about` for the default language too. Default false */
    prefixDefault?: boolean;
}

export interface LocalizedPath {
    locale: string;
    /** `home` for the language's root */
    slug: string;
    /** The language was in the path (`/en/…`) */
    prefixed: boolean;
}

export function localeFromPath(pathname: string, routing: LocaleRouting): LocalizedPath {
    const parts = pathname.split('/').filter(Boolean);
    const first = parts[0]?.toLowerCase();
    const match = routing.locales.find((locale) => locale.toLowerCase() === first);
    if (match && (routing.prefixDefault || match !== routing.defaultLocale)) {
        return { locale: match, slug: parts.slice(1).join('/') || 'home', prefixed: true };
    }
    return { locale: routing.defaultLocale, slug: parts.join('/') || 'home', prefixed: false };
}

/** The path of a slug in a language: the inverse of `localeFromPath` */
export function localizedPath(slug: string, locale: string, routing: LocaleRouting): string {
    const path = slug === 'home' ? '' : slug.replace(/^\/+|\/+$/g, '');
    const prefix = routing.prefixDefault || locale !== routing.defaultLocale ? `/${locale}` : '';
    return `${prefix}/${path}`.replace(/\/+$/, '') || '/';
}
