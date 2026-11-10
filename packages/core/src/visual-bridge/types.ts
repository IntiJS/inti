/**
 * VisualBridge - Universal Visual Editing System for Inti.js
 * 
 * Lets you edit content visually from Astro, working
 * with any CMS (WordPress, Kitsuden, Strapi, Contentful, Sanity, etc.)
 * 
 * Features:
 * - Visual overlay on the page
 * - Automatic block detection
 * - Contextual toolbar per block type
 * - Real-time preview
 * - Navigation to the CMS for editing
 */

// ============================================
// Visual Bridge configuration
// ============================================

export interface VisualBridgeConfig {
    /** Enable/disable */
    enabled: boolean;
    /** Active CMS (wordpress, kitsuden, strapi, contentful, sanity, etc.) */
    cms: string;
    /** CMS-specific configuration */
    cmsConfig?: {
        /** Base URL of the CMS admin */
        adminUrl?: string;
        /** Preview API endpoint */
        previewEndpoint?: string;
        /** API key for preview */
        previewToken?: string;
    };
    /** Display configuration */
    display?: {
        /** Show overlay on hover */
        highlightOnHover?: boolean;
        /** Always show block borders */
        alwaysShowBorders?: boolean;
        /** Toolbar position (top, bottom, left, right) */
        toolbarPosition?: 'top' | 'bottom' | 'left' | 'right';
        /** Overlay theme */
        theme?: 'light' | 'dark' | 'auto';
    };
    /** Enabled features */
    features?: {
        /** Edit in CMS */
        editInCms?: boolean;
        /** Real-time preview */
        livePreview?: boolean;
        /** Drag and drop blocks */
        dragDrop?: boolean;
        /** Add blocks */
        addBlocks?: boolean;
        /** Delete blocks */
        deleteBlocks?: boolean;
        /** Duplicate blocks */
        duplicateBlocks?: boolean;
        /** Edit inline (if the CMS supports it) */
        inlineEdit?: boolean;
    };
    /** Callbacks */
    callbacks?: {
        /** On clicking "Edit" */
        onEdit?: (block: BridgeBlockInfo) => void;
        /** On changing something in preview */
        onPreviewChange?: (change: PreviewChange) => void;
        /** On navigating to the CMS */
        onNavigateToCms?: (url: string) => void;
    };
}

// ============================================
// Block information
// ============================================

export interface BridgeBlockInfo {
    /** Unique block ID */
    id: string;
    /** Block type */
    type: string;
    /** Block name/label */
    label?: string;
    /** ID of the parent document/content */
    documentId: string;
    /** Content type (page, post, etc.) */
    contentType: string;
    /** Locale/language */
    locale?: string;
    /** Block data */
    data: Record<string, any>;
    /** Position on the page */
    position: {
        index: number;
        total: number;
    };
    /** Direct URL to the CMS editor */
    editUrl?: string;
    /** Whether it is in draft mode */
    isDraft?: boolean;
    /** Last modification */
    updatedAt?: string;
}

export interface BridgePageInfo {
    /** Page ID */
    id: string;
    /** Slug/URL */
    slug: string;
    /** Title */
    title: string;
    /** Content type */
    contentType: string;
    /** Locale */
    locale?: string;
    /** URL to the CMS editor */
    editUrl?: string;
    /** Blocks on the page */
    blocks: BridgeBlockInfo[];
    /** Metadata */
    meta?: {
        publishedAt?: string;
        updatedAt?: string;
        author?: string;
    };
}

// ============================================
// Preview and changes
// ============================================

export interface PreviewChange {
    /** Change type */
    type: 'content' | 'order' | 'add' | 'remove' | 'settings';
    /** Affected block */
    blockId: string;
    /** Modified field (if applicable) */
    field?: string;
    /** Previous value */
    oldValue?: any;
    /** New value */
    newValue?: any;
    /** Timestamp */
    timestamp: number;
}

export interface PreviewState {
    /** Whether preview mode is active */
    isActive: boolean;
    /** ID of the document in preview */
    documentId?: string;
    /** Version in preview */
    version?: string;
    /** Pending changes */
    pendingChanges: PreviewChange[];
    /** Whether there are unsaved changes */
    hasUnsavedChanges: boolean;
}

// ============================================
// Toolbar and UI
// ============================================

export interface ToolbarAction {
    /** Action ID */
    id: string;
    /** Label */
    label: string;
    /** Icon (name or SVG) */
    icon: string;
    /** Action to run */
    action: 'edit' | 'delete' | 'duplicate' | 'moveUp' | 'moveDown' | 'add' | 'custom';
    /** Whether it requires confirmation */
    confirm?: boolean;
    /** Confirmation message */
    confirmMessage?: string;
    /** Enabled */
    enabled?: boolean;
}

export interface BlockToolbarConfig {
    /** Actions available for this block type */
    actions: ToolbarAction[];
    /** Specific colors/styles */
    theme?: {
        borderColor?: string;
        backgroundColor?: string;
        textColor?: string;
    };
}

// ============================================
// CMS connection
// ============================================

export interface CmsConnector {
    /** CMS name */
    name: string;
    /** Build the edit URL */
    getEditUrl(block: BridgeBlockInfo): string;
    /** Build the preview URL */
    getPreviewUrl?(documentId: string, params?: Record<string, any>): string;
    /** Fetch up-to-date data */
    fetchLatest?(blockId: string): Promise<BridgeBlockInfo | null>;
    /** Subscribe to real-time changes */
    subscribeToChanges?(
        documentId: string, 
        callback: (change: PreviewChange) => void
    ): () => void;
    /** Reorder blocks in the CMS */
    reorderBlocks?(documentId: string, blockIds: string[]): Promise<void>;
    /** Delete a block in the CMS */
    deleteBlock?(documentId: string, blockId: string): Promise<void>;
    /** Duplicate a block in the CMS */
    duplicateBlock?(documentId: string, blockId: string): Promise<BridgeBlockInfo | null>;
}

// ============================================
// Events
// ============================================

export type VisualBridgeEventType =
    | 'init'
    | 'blockHover'
    | 'blockSelect'
    | 'blockEdit'
    | 'blockDelete'
    | 'blockMove'
    | 'blockReorder'
    | 'reorder'
    | 'previewUpdate'
    | 'navigateToCms'
    | 'syncStart'
    | 'syncSuccess'
    | 'syncError'
    | 'syncRetry';

export interface VisualBridgeEvent {
    type: VisualBridgeEventType;
    timestamp: number;
    /** Related block */
    block?: BridgeBlockInfo;
    /** Related page */
    page?: BridgePageInfo;
    /** Additional data */
    data?: any;
}

export type VisualBridgeEventHandler = (event: VisualBridgeEvent) => void;

// ============================================
// Global state
// ============================================

export interface VisualBridgeState {
    /** Active configuration */
    config: VisualBridgeConfig;
    /** Current page */
    currentPage?: BridgePageInfo;
    /** Selected block */
    selectedBlock?: BridgeBlockInfo;
    /** Preview state */
    preview: PreviewState;
    /** Whether the overlay is visible */
    overlayVisible: boolean;
    /** Active CMS connector */
    cmsConnector?: CmsConnector;
}

// ============================================
// Drag & Drop configuration
// ============================================

export interface DragDropConfig {
    /** Enable/disable drag & drop */
    enabled: boolean;
    /** CSS selector for the drag handle (e.g. '[data-inti-drag-handle]') */
    handle?: string;
    /** Duration of the CSS animations in ms */
    animationDuration: number;
    /** Drop indicator color */
    dropIndicatorColor?: string;
    /** Ghost element opacity while dragging */
    ghostOpacity?: number;
}

// ============================================
// CMS sync operations
// ============================================

export interface CmsSyncOperation {
    /** Operation type */
    type: 'reorder' | 'delete' | 'duplicate' | 'update';
    /** ID of the affected document */
    documentId: string;
    /** ID of the affected block (for delete, duplicate, update) */
    blockId?: string;
    /** Array of block IDs in the new order (for reorder) */
    blockIds?: string[];
    /** Additional operation data */
    data?: Record<string, any>;
}
