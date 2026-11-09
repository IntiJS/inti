/**
 * VisualBridge Engine - Visual Editing engine
 * 
 * Handles:
 * - Block detection in the DOM
 * - Visual overlay
 * - Communication with the CMS
 * - Real-time preview
 */

import type {
    VisualBridgeConfig,
    VisualBridgeState,
    VisualBridgeEvent,
    VisualBridgeEventType,
    VisualBridgeEventHandler,
    BridgeBlockInfo,
    BridgePageInfo,
    PreviewChange,
    CmsConnector
} from './types.js';
import { DragDropEngine } from './drag-drop.js';
import { CmsSyncManager } from './cms-sync.js';

// ============================================
// CMS connectors
// ============================================

class StrapiConnector implements CmsConnector {
    name = 'Strapi';
    private adminUrl: string;
    
    constructor(adminUrl: string) {
        this.adminUrl = adminUrl;
    }
    
    getEditUrl(block: BridgeBlockInfo): string {
        // Strapi v5: /admin/content-manager/collection-types/[api::content-type]/[id]
        return `${this.adminUrl}/admin/content-manager/collection-types/${block.contentType}/${block.documentId}`;
    }
    
    getPreviewUrl(documentId: string, params?: Record<string, any>): string {
        return `${this.adminUrl}/admin/preview/${documentId}${params ? '?' + new URLSearchParams(params) : ''}`;
    }
}

class ContentfulConnector implements CmsConnector {
    name = 'Contentful';
    private adminUrl: string;
    private spaceId: string;
    
    constructor(adminUrl: string, spaceId: string) {
        this.adminUrl = adminUrl;
        this.spaceId = spaceId;
    }
    
    getEditUrl(block: BridgeBlockInfo): string {
        // Contentful: /spaces/[spaceId]/entries/[entryId]
        return `${this.adminUrl}/spaces/${this.spaceId}/entries/${block.documentId}`;
    }
}

class SanityConnector implements CmsConnector {
    name = 'Sanity';
    private adminUrl: string;
    private projectId: string;
    
    constructor(adminUrl: string, projectId: string) {
        this.adminUrl = adminUrl;
        this.projectId = projectId;
    }
    
    getEditUrl(block: BridgeBlockInfo): string {
        // Sanity Studio: /desk/[type];[id]
        return `${this.adminUrl}/desk/${block.contentType};${block.documentId}`;
    }
}

class GremiusConnector implements CmsConnector {
    name = 'Gremius';
    private adminUrl: string;

    constructor(adminUrl: string) {
        this.adminUrl = adminUrl;
    }

    getEditUrl(block: BridgeBlockInfo): string {
        return `${this.adminUrl}/admin/content/${block.contentType}/${block.documentId}`;
    }
}

class WordPressConnector implements CmsConnector {
    name = 'WordPress';
    private adminUrl: string;

    constructor(adminUrl: string) {
        // adminUrl may come as https://site.com/wp-admin or just the domain
        this.adminUrl = adminUrl.replace(/\/wp-admin\/?$/, '');
    }

    getEditUrl(block: BridgeBlockInfo): string {
        // Classic WP editor: /wp-admin/post.php?post=[id]&action=edit
        return `${this.adminUrl}/wp-admin/post.php?post=${block.documentId}&action=edit`;
    }
}

// Connector factory
export function createCmsConnector(
    cms: string, 
    config: { adminUrl: string; spaceId?: string; projectId?: string }
): CmsConnector {
    switch (cms.toLowerCase()) {
        case 'strapi':
            return new StrapiConnector(config.adminUrl);
        case 'contentful':
            return new ContentfulConnector(config.adminUrl, config.spaceId || '');
        case 'sanity':
            return new SanityConnector(config.adminUrl, config.projectId || '');
        case 'gremius':
            return new GremiusConnector(config.adminUrl);
        case 'wordpress':
            return new WordPressConnector(config.adminUrl);
        default:
            // Generic connector
            return {
                name: cms,
                getEditUrl: (block: BridgeBlockInfo) => `${config.adminUrl}/edit/${block.documentId}`
            };
    }
}

// ============================================
// VisualBridge Engine
// ============================================

export class VisualBridgeEngine {
    private config: VisualBridgeConfig;
    private state: VisualBridgeState;
    private eventHandlers: Map<VisualBridgeEventType, VisualBridgeEventHandler[]> = new Map();
    private overlay: HTMLElement | null = null;
    private highlightedBlock: HTMLElement | null = null;
    private selectedBlock: HTMLElement | null = null;
    private dragDropEngine: DragDropEngine | null = null;
    private syncManager: CmsSyncManager | null = null;
    
    constructor(config: VisualBridgeConfig) {
        this.config = config;
        this.state = {
            config,
            preview: {
                isActive: false,
                pendingChanges: [],
                hasUnsavedChanges: false
            },
            overlayVisible: false
        };
        
        // Create the CMS connector
        if (config.cmsConfig?.adminUrl) {
            this.state.cmsConnector = createCmsConnector(config.cms, {
                adminUrl: config.cmsConfig.adminUrl,
                spaceId: config.cmsConfig.previewToken, // Use the token as spaceId for Contentful
                projectId: config.cmsConfig.previewToken // Use the token as projectId for Sanity
            });
            this.syncManager = new CmsSyncManager(this.state.cmsConnector);
        }
    }
    
    /**
     * Initialize Visual Bridge
     */
    init(): void {
        if (!this.config.enabled) return;
        if (typeof window === 'undefined') return; // Client only
        
        console.log(`[VisualBridge] Initializing for ${this.config.cms}...`);
        
        // Create the overlay
        this.createOverlay();
        
        // Detect blocks
        this.detectBlocks();
        
        // Event listeners
        this.attachEventListeners();
        
        // Emit the event
        this.emit('init', {});
        
        // Initialize Drag & Drop
        if (this.config.features?.dragDrop) {
            this.dragDropEngine = new DragDropEngine({
                enabled: true,
                animationDuration: 300,
                ...(typeof this.config.features.dragDrop === 'object' ? this.config.features.dragDrop : {})
            } as any);
            
            // Connect to sync manager
            if (this.syncManager) {
                this.dragDropEngine.on('reorder', (event: any) => {
                    if (event.documentId && event.blockIds) {
                        this.syncManager?.queueOperation({
                            type: 'reorder',
                            documentId: event.documentId,
                            blockIds: event.blockIds
                        });
                    }
                });
            }
            
            this.dragDropEngine.init();
        }
        
        console.log('[VisualBridge] Ready');
    }
    
    /**
     * Destroy Visual Bridge
     */
    destroy(): void {
        this.overlay?.remove();
        this.overlay = null;
        this.highlightedBlock = null;
        this.selectedBlock = null;
    }
    
    // ============================================
    // UI creation
    // ============================================
    
    private createOverlay(): void {
        const overlay = document.createElement('div');
        overlay.id = 'inti-visual-bridge';
        overlay.className = `inti-vb-overlay inti-vb-theme-${this.config.display?.theme || 'auto'}`;
        overlay.innerHTML = `
            <div class="inti-vb-toolbar" data-position="${this.config.display?.toolbarPosition || 'top'}">
                <div class="inti-vb-toolbar-header">
                    <span class="inti-vb-logo">🎨 Inti Visual Bridge</span>
                    <span class="inti-vb-cms">${this.config.cms}</span>
                </div>
                <div class="inti-vb-toolbar-actions">
                    <button class="inti-vb-btn" data-action="toggleBorders" title="Toggle Borders">
                        ⊞
                    </button>
                    <button class="inti-vb-btn" data-action="refresh" title="Refresh">
                        ↻
                    </button>
                </div>
            </div>
            <div class="inti-vb-block-toolbar" hidden>
                <span class="inti-vb-block-type"></span>
                <div class="inti-vb-block-actions">
                    <button class="inti-vb-btn" data-action="edit" title="Edit in CMS">✎</button>
                    <button class="inti-vb-btn" data-action="moveUp" title="Move Up">↑</button>
                    <button class="inti-vb-btn" data-action="moveDown" title="Move Down">↓</button>
                    <button class="inti-vb-btn" data-action="duplicate" title="Duplicate">⎘</button>
                    <button class="inti-vb-btn inti-vb-btn-danger" data-action="delete" title="Delete">×</button>
                </div>
            </div>
            <div class="inti-vb-highlight" hidden></div>
            <div class="inti-vb-toast-container"></div>
        `;
        
        document.body.appendChild(overlay);
        this.overlay = overlay;
        this.state.overlayVisible = true;
        
        // Attach toolbar events
        this.attachToolbarEvents();
    }
    
    private attachToolbarEvents(): void {
        if (!this.overlay) return;
        
        // Toggle borders
        this.overlay.querySelector('[data-action="toggleBorders"]')?.addEventListener('click', () => {
            document.body.classList.toggle('inti-vb-show-borders');
        });
        
        // Refresh
        this.overlay.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
            this.detectBlocks();
            this.showToast('Blocks refreshed', 'info');
        });
        
        // Block actions
        const blockToolbar = this.overlay.querySelector('.inti-vb-block-toolbar');
        
        blockToolbar?.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
            if (this.selectedBlock) {
                this.editBlock(this.selectedBlock);
            }
        });
        
        blockToolbar?.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            if (this.selectedBlock && confirm('Are you sure you want to delete this block?')) {
                this.deleteBlock(this.selectedBlock);
            }
        });
        
        blockToolbar?.querySelector('[data-action="duplicate"]')?.addEventListener('click', () => {
            if (this.selectedBlock) {
                this.duplicateBlock(this.selectedBlock);
            }
        });
        
        blockToolbar?.querySelector('[data-action="moveUp"]')?.addEventListener('click', () => {
            if (this.selectedBlock) {
                this.moveBlock(this.selectedBlock, 'up');
            }
        });
        
        blockToolbar?.querySelector('[data-action="moveDown"]')?.addEventListener('click', () => {
            if (this.selectedBlock) {
                this.moveBlock(this.selectedBlock, 'down');
            }
        });
    }
    
    // ============================================
    // Block detection
    // ============================================
    
    private detectBlocks(): void {
        if (typeof document === 'undefined') return;
        
        // Find elements with data-inti-block
        const blocks = document.querySelectorAll('[data-inti-block]');
        
        blocks.forEach((block, index) => {
            const element = block as HTMLElement;
            
            // Add attributes if they lack them
            if (!element.dataset.intiBlockId) {
                element.dataset.intiBlockId = `block-${index}`;
            }
            
            // Add a class for CSS
            element.classList.add('inti-vb-detectable');
            
            // Interaction events
            element.addEventListener('mouseenter', (e) => this.onBlockHover(e, element));
            element.addEventListener('mouseleave', () => this.onBlockLeave());
            element.addEventListener('click', (e) => this.onBlockClick(e, element));
        });
        
        console.log(`[VisualBridge] Detected ${blocks.length} blocks`);
    }
    
    // ============================================
    // Event Handlers
    // ============================================
    
    private attachEventListeners(): void {
        // Keys
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.deselectBlock();
            }
        });
        
        // Resize
        window.addEventListener('resize', () => {
            if (this.selectedBlock) {
                this.updateHighlightPosition(this.selectedBlock);
            }
        });
    }
    
    private onBlockHover(event: MouseEvent, element: HTMLElement): void {
        if (!this.config.display?.highlightOnHover) return;
        if (this.selectedBlock) return; // No hover while there is a selection
        
        this.highlightedBlock = element;
        this.showHighlight(element);
        
        const blockInfo = this.extractBlockInfo(element);
        this.emit('blockHover', { block: blockInfo });
    }
    
    private onBlockLeave(): void {
        if (!this.selectedBlock) {
            this.hideHighlight();
        }
        this.highlightedBlock = null;
    }
    
    private onBlockClick(event: MouseEvent, element: HTMLElement): void {
        event.preventDefault();
        event.stopPropagation();
        
        this.selectBlock(element);
        
        const blockInfo = this.extractBlockInfo(element);
        this.emit('blockSelect', { block: blockInfo });
    }
    
    // ============================================
    // Block management
    // ============================================
    
    private selectBlock(element: HTMLElement): void {
        this.selectedBlock = element;
        this.showHighlight(element, true);
        this.showBlockToolbar(element);
        
        element.classList.add('inti-vb-selected');
    }
    
    private deselectBlock(): void {
        if (this.selectedBlock) {
            this.selectedBlock.classList.remove('inti-vb-selected');
        }
        this.selectedBlock = null;
        this.hideBlockToolbar();
        this.hideHighlight();
    }
    
    private editBlock(element: HTMLElement): void {
        if (!this.state.cmsConnector) {
            this.showToast('CMS connector not configured', 'error');
            return;
        }
        
        const blockInfo = this.extractBlockInfo(element);
        const editUrl = this.state.cmsConnector.getEditUrl(blockInfo);
        
        this.emit('blockEdit', { block: blockInfo, data: { url: editUrl } });
        
        if (this.config.callbacks?.onEdit) {
            this.config.callbacks.onEdit(blockInfo);
        } else {
            // Navigate to the CMS
            window.open(editUrl, '_blank');
            this.emit('navigateToCms', { data: { url: editUrl } });
        }
    }
    
    private deleteBlock(element: HTMLElement): void {
        const blockInfo = this.extractBlockInfo(element);
        
        this.emit('blockDelete', { block: blockInfo });
        
        if (this.syncManager) {
            this.syncManager.queueOperation({
                type: 'delete',
                documentId: blockInfo.documentId,
                blockId: blockInfo.id
            });
            this.showToast('Block deleted', 'success');
            element.remove(); // Optimistic UI
        } else {
            this.showToast('CMS sync not configured', 'warning');
        }
        this.deselectBlock();
    }
    
    private duplicateBlock(element: HTMLElement): void {
        const blockInfo = this.extractBlockInfo(element);
        this.emit('blockEdit', { block: blockInfo, data: { action: 'duplicate' } });
        
        if (this.syncManager) {
            this.syncManager.queueOperation({
                type: 'duplicate',
                documentId: blockInfo.documentId,
                blockId: blockInfo.id
            });
            this.showToast('Block duplication queued', 'success');
        } else {
            this.showToast('CMS sync not configured', 'warning');
        }
    }
    
    private moveBlock(element: HTMLElement, direction: 'up' | 'down'): void {
        const blockInfo = this.extractBlockInfo(element);
        this.emit('blockMove', { block: blockInfo, data: { direction } });
        
        if (this.dragDropEngine) {
            // Trigger move programmatically
            (this.dragDropEngine as any).moveBlock?.(element, direction);
            this.showToast(`Moved block ${direction}`, 'success');
        } else {
            this.showToast(`Drag Drop engine not active`, 'warning');
        }
    }
    
    getDragDropEngine(): DragDropEngine | null {
        return this.dragDropEngine;
    }
    
    getSyncManager(): CmsSyncManager | null {
        return this.syncManager;
    }
    
    // ============================================
    // UI Helpers
    // ============================================
    
    private showHighlight(element: HTMLElement, isSelected: boolean = false): void {
        const highlight = this.overlay?.querySelector('.inti-vb-highlight') as HTMLElement;
        if (!highlight) return;
        
        const rect = element.getBoundingClientRect();
        
        highlight.style.left = `${rect.left + window.scrollX}px`;
        highlight.style.top = `${rect.top + window.scrollY}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height}px`;
        highlight.hidden = false;
        
        if (isSelected) {
            highlight.classList.add('inti-vb-selected');
        } else {
            highlight.classList.remove('inti-vb-selected');
        }
    }
    
    private hideHighlight(): void {
        const highlight = this.overlay?.querySelector('.inti-vb-highlight') as HTMLElement;
        if (highlight) {
            highlight.hidden = true;
            highlight.classList.remove('inti-vb-selected');
        }
    }
    
    private updateHighlightPosition(element: HTMLElement): void {
        if (this.selectedBlock === element || this.highlightedBlock === element) {
            this.showHighlight(element, this.selectedBlock === element);
        }
    }
    
    private showBlockToolbar(element: HTMLElement): void {
        const toolbar = this.overlay?.querySelector('.inti-vb-block-toolbar') as HTMLElement;
        if (!toolbar) return;
        
        const blockType = element.dataset.intiBlock || 'unknown';
        toolbar.querySelector('.inti-vb-block-type')!.textContent = blockType;
        
        const rect = element.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        
        // Position the toolbar above the block
        let top = rect.top + window.scrollY - toolbarRect.height - 8;
        let left = rect.left + window.scrollX;
        
        // Adjust if it goes off screen
        if (top < 0) {
            top = rect.bottom + window.scrollY + 8;
        }
        
        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${top}px`;
        toolbar.hidden = false;
    }
    
    private hideBlockToolbar(): void {
        const toolbar = this.overlay?.querySelector('.inti-vb-block-toolbar') as HTMLElement;
        if (toolbar) {
            toolbar.hidden = true;
        }
    }
    
    private showToast(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
        const container = this.overlay?.querySelector('.inti-vb-toast-container');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `inti-vb-toast inti-vb-toast-${type}`;
        toast.textContent = message;
        
        container.appendChild(toast);
        
        // Entry animation
        requestAnimationFrame(() => {
            toast.classList.add('inti-vb-toast-visible');
        });
        
        // Auto-remove
        setTimeout(() => {
            toast.classList.remove('inti-vb-toast-visible');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
    
    // ============================================
    // Info extraction
    // ============================================
    
    private extractBlockInfo(element: HTMLElement): BridgeBlockInfo {
        return {
            id: element.dataset.intiBlockId || 'unknown',
            type: element.dataset.intiBlock || 'unknown',
            label: element.dataset.intiBlockLabel,
            documentId: element.dataset.intiDocumentId || 'unknown',
            contentType: element.dataset.intiContentType || 'page',
            locale: element.dataset.intiLocale,
            data: {}, // Could be extracted from data attributes
            position: {
                index: parseInt(element.dataset.intiBlockIndex || '0'),
                total: parseInt(element.dataset.intiBlockTotal || '0')
            }
        };
    }
    
    // ============================================
    // Event System
    // ============================================
    
    on(event: VisualBridgeEventType, handler: VisualBridgeEventHandler): void {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event)!.push(handler);
    }
    
    off(event: VisualBridgeEventType, handler: VisualBridgeEventHandler): void {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) handlers.splice(index, 1);
        }
    }
    
    private emit(type: VisualBridgeEventType, data: Partial<VisualBridgeEvent>): void {
        const event: VisualBridgeEvent = {
            type,
            timestamp: Date.now(),
            ...data
        };
        
        const handlers = this.eventHandlers.get(type) || [];
        handlers.forEach(handler => {
            try {
                handler(event);
            } catch (error) {
                console.error(`[VisualBridge] Event handler error:`, error);
            }
        });
    }
    
    // ============================================
    // Getters
    // ============================================
    
    getState(): VisualBridgeState {
        return { ...this.state };
    }
    
    getConfig(): VisualBridgeConfig {
        return { ...this.config };
    }
}

// ============================================
// Global instance
// ============================================

let globalVisualBridge: VisualBridgeEngine | null = null;

export function initVisualBridge(config: VisualBridgeConfig): VisualBridgeEngine {
    if (globalVisualBridge) {
        globalVisualBridge.destroy();
    }
    globalVisualBridge = new VisualBridgeEngine(config);
    globalVisualBridge.init();
    return globalVisualBridge;
}

export function getVisualBridge(): VisualBridgeEngine | null {
    return globalVisualBridge;
}

export function destroyVisualBridge(): void {
    globalVisualBridge?.destroy();
    globalVisualBridge = null;
}
