/**
 * `@intijs/adapter-kitsuden/astro`: what every Astro site on Kitsuden used to copy.
 *
 * - `kitsudenMiddleware`: editor sessions, visitor IP, private editor responses, HTML cache,
 *   503 when Kitsuden cannot answer.
 * - `createPageCache` + `purgeRoute`: the cache and the webhook that empties it.
 * - `mediaPresetRoute`, `mediaFileRoute`, `imageSrc`, `sameOriginMediaUrl`: media from the
 *   site's own origin, with Range for video.
 * - `blockAttributes`, `fieldAttributes`, `blockJson`, `markupFor`: the editing markup for
 *   sites that render blocks themselves.
 * - `stripSecretsForBuild`, `kitsudenActions`: build-time safety and the optional actions route.
 */

export { kitsudenMiddleware, type KitsudenMiddlewareOptions, type MiddlewareContextLike } from './middleware.js';
export { createPageCache, purgeRoute, isCacheable, type PageCache, type PageCacheOptions, type CachedPage } from './cache.js';
export {
    sessionCookies,
    editorFromSession,
    resolveEditor,
    perRequest,
    kitsudenEditorPlugin,
    DEFAULT_EDITOR_ROLES,
    type KitsudenEditor,
    type ResolveEditorOptions
} from './session.js';
export { runWithVisitor, currentVisitorIp, visitorIp } from './visitor.js';
export {
    MEDIA_PRESETS,
    MEDIA_KEY,
    isMediaId,
    isMediaPreset,
    mediaPath,
    sameOriginMediaUrl,
    imageSrc,
    proxyMedia,
    mediaPresetRoute,
    mediaFileRoute,
    type ProxyMediaOptions
} from './media.js';
export { blockAttributes, fieldAttributes, blockJson, markupFor, type IntiAttributes, type MarkupContext } from './markup.js';
export { stripSecretsForBuild, kitsudenActions, KITSUDEN_SECRETS } from './build.js';
