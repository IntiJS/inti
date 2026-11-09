/**
 * @intijs/cloudflare — optional backends for deploying Inti on Cloudflare.
 *
 * Inti does not depend on this: each piece implements a contract that already existed, and
 * plugs in with a plugin. The Durable Objects live in `@intijs/cloudflare/durable`.
 */

export {
    createD1ComposeCache,
    createD1ExperimentStore,
    createD1PatternStore,
    D1_SCHEMA,
    D1ContentAdapter,
    migrateD1
} from './d1.js';

export { createR2MediaStore, detectImageType } from './r2.js';
export type { R2MediaConfig, R2MediaItem, UploadResult } from './r2.js';

export { createWorkersAiProvider, WORKERS_AI_DEFAULT_MODEL } from './ai.js';
export type { WorkersAiConfig } from './ai.js';

export { cloudflareImageSrcset, cloudflareImageUrl, createCloudflareImageService } from './images.js';
export type { CloudflareImageOptions, CloudflareImagesConfig } from './images.js';
