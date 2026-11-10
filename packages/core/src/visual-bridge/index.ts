/**
 * VisualBridge - Universal Visual Editing System for Inti.js
 * 
 * Lets you edit content visually from Astro, working
 * with any CMS (WordPress, Kitsuden, Strapi, Contentful, Sanity, etc.)
 */

// Types
export type {
    VisualBridgeConfig,
    BridgeBlockInfo,
    BridgePageInfo,
    PreviewChange,
    PreviewState,
    ToolbarAction,
    BlockToolbarConfig,
    CmsConnector,
    VisualBridgeEvent,
    VisualBridgeEventType,
    VisualBridgeEventHandler,
    VisualBridgeState
} from './types.js';

// Engine
export {
    VisualBridgeEngine,
    initVisualBridge,
    getVisualBridge,
    destroyVisualBridge,
    createCmsConnector
} from './engine.js';

// Drag & Drop
export { DragDropEngine } from './drag-drop.js';

// CMS Sync
export { CmsSyncManager } from './cms-sync.js';

// Auto-detection
export {
    detectCmsFromAdapter,
    resolveAdminUrl,
    createVisualBridgeConfig,
    isDevelopment,
    shouldEnableVisualBridge
} from './auto-detect.js';

// Inline Editing (real write-back on the page)
export {
    InlineEditor,
    initInlineEditor,
    getInlineEditor
} from './inline-editor.js';

export type {
    InlineEditorConfig,
    InlineSaveResult
} from './inline-editor.js';

// Block drag & drop with write-back
export { BlockReorder, initBlockReorder } from './block-reorder.js';
export type { BlockReorderConfig } from './block-reorder.js';

// Composer: visual composition of pages from blocks
export { BlockComposer, initBlockComposer } from './block-composer.js';
export type { BlockComposerConfig, ComposerBlockType } from './block-composer.js';
