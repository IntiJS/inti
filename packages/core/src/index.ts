/**
 * @intijs/core — The visual editing layer for headless WordPress on Astro
 * 
 * Connect any CMS with validated blocks, smart forms, and visual editing.
 * 
 * @example
 * ```ts
 * // astro.config.mjs
 * import { defineConfig } from 'astro/config';
 * import inti from '@intijs/core';
 * 
 * export default defineConfig({
 *   integrations: [inti()]
 * });
 * ```
 */

// Astro Integration (default export for astro add)
export { default, type IntiIntegrationOptions } from './integration/index.js';

// Types
export type {
    IntiBlock,
    IntiPage,
    IntiNavigation,
    IntiNavigationItem,
    IntiSchema,
    IntiConfig,
} from './types/index.js';

// Schema & Introspection
export type { FieldType, SchemaField, SchemaCollection, SchemaDefinition } from './adapters/index.js';
export {
    IntrospectionAdapter,
    globalSchemaCache,
    createSchemaField,
    createSchemaCollection,
    createSchemaDefinition
} from './adapters/introspection.js';
export type {
    IntrospectionConfig,
    IntrospectionResult
} from './adapters/introspection.js';

// Actions (Astro 4.15+)
export { intiActions } from './actions/index.js';

// Logger


// Registry
export { ComponentRegistry, registry } from './registry/index.js';
export type { BlockRegistration, ComponentModule } from './registry/index.js';

// Adapters
export { IntiAdapter, ContentAdapter, isWritableAdapter, isSearchableAdapter } from './adapters/index.js';
export type { WritableAdapter, WriteResult, SearchableAdapter, EntrySummary } from './adapters/index.js';

// Runtime
export { IntiStore, globalStore } from './runtime/index.js';

// Image
export { ImageService, configureImageService, getImageService } from './image/index.js';
export type { MediaAsset, OptimizedImage, ImageTransformOptions, ResponsiveImageOptions } from './types/media.js';

// Transformers
export { 
    TransformerPipeline, 
    MarkdownTransformer, 
    MDXTransformer,
    RichTextTransformer,
    transformContent 
} from './transformers/index.js';
export type { Transformer, TransformContext } from './transformers/index.js';

// Preview
export { 
    PreviewServer, 
    createPreviewServer,
    usePreviewMode,
    isPreviewMode 
} from './preview/index.js';
export type { PreviewConfig, PreviewMessage } from './preview/index.js';

// Integrations (adaptive styling)
export { intiStyles } from './integrations/inti-styles.js';

// Validation (ValidatedBlocks)
export {
    ValidationEngine,
    MathEvaluator,
    getValidationEngine,
    createValidationEngine,
    // Helpers
    required,
    math,
    range,
    regex,
    compare,
    dependsOn,
    custom,
    typeCheck
} from './validation/index.js';

export type {
    ValidationRule,
    ValidationRuleType,
    ValidationSeverity,
    ValidationContext,
    ValidationResult,
    ValidationSummary,
    BlockValidationConfig,
    ValidatedBlock,
    ValidationInputConfig,
    ValidationOutputConfig,
    VisualValidationConfig,
    ValidationSchema
} from './validation/index.js';

// Forms
export {
    FormEngine,
    getFormEngine,
    createFormEngine,
    createFormField,
    createFormSchema
} from './forms/index.js';

export type {
    FormSchema,
    FormField,
    FormFieldType,
    FormState,
    FormSubmission,
    FormSubmissionResult,
    FormSubmissionConfig,
    SpamProtectionConfig,
    FormEngineConfig
} from './forms/index.js';

// Visual Bridge
export {
    VisualBridgeEngine,
    initVisualBridge,
    getVisualBridge,
    destroyVisualBridge,
    createCmsConnector,
    InlineEditor,
    initInlineEditor,
    getInlineEditor
} from './visual-bridge/index.js';

export type {
    InlineEditorConfig,
    InlineSaveResult
} from './visual-bridge/index.js';

export type {
    VisualBridgeConfig,
    BridgeBlockInfo,
    BridgePageInfo,
    PreviewChange,
    CmsConnector,
    VisualBridgeEvent
} from './visual-bridge/index.js';

// Cache
export {
    CacheManager,
    MemoryCacheProvider,
    CachedAdapter,
    createCacheManager,
    getGlobalCache
} from './cache/index.js';

export type {
    CacheConfig,
    CacheEntry,
    CacheProvider,
    CacheSetOptions,
    CacheStats
} from './cache/index.js';

// Real-time Collaboration
export {
    RealtimeClient,
    initRealtime,
    getRealtimeClient,
    disconnectRealtime,
    createContentUpdate,
    generateRoomId
} from './realtime/index.js';

export type {
    RealtimeConfig,
    UserPresence,
    CursorPosition,
    ContentUpdate,
    Conflict,
    ConflictResolution,
    RealtimeEvent
} from './realtime/index.js';

// Configuration helper
export { defineConfig } from './config.js';

// Version
export const VERSION = '0.1.0';
