export { buildMetaTags, hreflangLinks } from './meta.js';
export { localeFromPath, localizedPath } from './i18n.js';
export type { LocaleRouting, LocalizedPath } from './i18n.js';
export type { MetaTag, SeoOptions } from './meta.js';

export {
    buildStructuredData,
    serializeJsonLd,
    faqFromBlock,
    howToFromBlock
} from './structured-data.js';
export type {
    JsonLdNode,
    BlockSchemaBuilder,
    BreadcrumbEntry,
    StructuredDataOptions
} from './structured-data.js';

export { buildProductSchema, auditProductSchema } from './product.js';
export type {
    ProductInput,
    ProductOffer,
    ProductRating,
    ProductAvailability,
    ProductCondition,
    ProductSchemaOptions
} from './product.js';

export {
    buildSitemapXml,
    toSitemapEntries,
    buildRobotsTxt,
    buildSitemapIndexXml,
    chunkSitemap,
    sitemapSection,
    sitemapIndexRoute,
    sitemapFileRoute,
    SITEMAP_MAX_URLS,
    SITEMAP_MAX_BYTES
} from './sitemap.js';
export type { SitemapEntry, SitemapOptions, SitemapAlternate, SitemapSection, SitemapRouteOptions } from './sitemap.js';

export { extractSeo, mergeSeo, readPath, asImageUrl } from './extract.js';
export type { SeoFieldMap, FieldPath } from './extract.js';

export { auditPage, auditBlock, formatAudit, hasErrors } from './audit.js';
export type { AuditFinding, AuditLevel, AuditOptions } from './audit.js';

export { buildLlmsTxt, pageToMarkdown } from './llms.js';
export type { LlmsTxtOptions, LlmsTxtSection } from './llms.js';
