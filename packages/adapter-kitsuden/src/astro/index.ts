/**
 * `@intijs/adapter-kitsuden/astro`: what every Astro site on Kitsuden used to copy.
 *
 * - `kitsudenMiddleware`: editor sessions, visitor IP, and delivery through `intiDelivery`
 *   (HTML cache, CDN headers, editor markup only for editors, 503 when Kitsuden cannot answer).
 * - `purgeRoute`: the webhook that empties the core cache when Kitsuden says a page changed.
 * - `mediaPresetRoute`, `mediaFileRoute`, `imageSrc`, `sameOriginMediaUrl`: media from the
 *   site's own origin, with Range for video.
 * - `blockAttributes`, `fieldAttributes`, `blockJson`, `markupFor`: the editing markup for
 *   sites that render blocks themselves.
 * - `stripSecretsForBuild`, `kitsudenActions`: build-time safety and the optional actions route.
 */

export { kitsudenMiddleware, type KitsudenMiddlewareOptions, type MiddlewareContextLike } from './middleware.js';
export { purgeRoute, parseKitsudenNotice } from './cache.js';
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
    mediaTransformRoute,
    kitsudenImage,
    transformPath,
    TRANSFORM_WIDTHS,
    TRANSFORM_FORMATS,
    type ProxyMediaOptions,
    type KitsudenImageOptions,
    type TransformFormat
} from './media.js';
export { blockAttributes, fieldAttributes, blockJson, markupFor, type IntiAttributes, type MarkupContext } from './markup.js';
export { stripSecretsForBuild, kitsudenActions, KITSUDEN_SECRETS } from './build.js';
