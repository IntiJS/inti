/**
 * DragDropEngine - Drag & Drop engine for Visual Bridge
 * 
 * Implements block drag and drop using the native HTML5 Drag and Drop API.
 * Shows visual drop indicators, position tracking, an undo stack,
 * and emits reorder events for syncing with the CMS.
 */

import type {
    DragDropConfig,
    VisualBridgeEventType,
    VisualBridgeEventHandler,
    VisualBridgeEvent
} from './types.js';

// ============================================
// Internal Drag & Drop types
// ============================================

/** Record of a reorder operation for the undo stack */
interface ReorderOperation {
    /** Operation timestamp */
    timestamp: number;
    /** ID of the moved block */
    blockId: string;
    /** Original index before the move */
    fromIndex: number;
    /** Target index after the move */
    toIndex: number;
    /** IDs of all blocks in the previous order */
    previousOrder: string[];
}

// ============================================
// DragDropEngine
// ============================================

export class DragDropEngine {
    private config: DragDropConfig;
    private enabled: boolean = false;
    private container: HTMLElement | null = null;
    private draggedElement: HTMLElement | null = null;
    private draggedBlockId: string | null = null;
    private dropIndicator: HTMLElement | null = null;
    private dropTargetIndex: number = -1;
    private undoStack: ReorderOperation[] = [];
    private eventHandlers: Map<VisualBridgeEventType, VisualBridgeEventHandler[]> = new Map();
    private boundHandlers: Map<HTMLElement, Record<string, EventListener>> = new Map();
    private styleElement: HTMLStyleElement | null = null;

    constructor(config: Partial<DragDropConfig> = {}) {
        this.config = {
            enabled: true,
            handle: '[data-inti-drag-handle]',
            animationDuration: 200,
            dropIndicatorColor: '#6366f1',
            ghostOpacity: 0.5,
            ...config
        };
    }

    // ============================================
    // Lifecycle
    // ============================================

    /**
     * Initialize the Drag & Drop engine.
     * Finds every [data-inti-block] and injects drag support into it.
     */
    init(container?: HTMLElement): void {
        if (typeof document === 'undefined') return;

        this.container = container || document.body;
        this.injectStyles();
        this.createDropIndicator();
        this.attachBlockListeners();
        this.enabled = this.config.enabled;

        console.log('[DragDrop] Initialized');
    }

    /**
     * Destroy the engine: cleans up listeners, styles and indicators.
     */
    destroy(): void {
        this.detachBlockListeners();
        this.dropIndicator?.remove();
        this.dropIndicator = null;
        this.styleElement?.remove();
        this.styleElement = null;
        this.draggedElement = null;
        this.draggedBlockId = null;
        this.undoStack = [];
        this.eventHandlers.clear();
        this.boundHandlers.clear();
        this.enabled = false;

        console.log('[DragDrop] Destroyed');
    }

    /**
     * Enable Drag & Drop
     */
    enable(): void {
        this.enabled = true;
        this.getBlockElements().forEach(el => {
            el.setAttribute('draggable', 'true');
        });
    }

    /**
     * Disable Drag & Drop
     */
    disable(): void {
        this.enabled = false;
        this.getBlockElements().forEach(el => {
            el.removeAttribute('draggable');
        });
    }

    // ============================================
    // State queries
    // ============================================

    /**
     * Get the current block order (array of blockIds).
     */
    getBlockOrder(): string[] {
        return this.getBlockElements().map(el => 
            el.dataset.intiBlockId || el.dataset.intiBlock || ''
        );
    }

    /**
     * Revert the last reorder operation.
     * Moves the DOM back to the previous state and emits the matching event.
     * @returns `true` if something was reverted, `false` if the undo stack was empty.
     */
    revertLastReorder(): boolean {
        const lastOp = this.undoStack.pop();
        if (!lastOp) return false;

        // Restore the DOM order based on previousOrder
        this.applyOrder(lastOp.previousOrder);

        this.emit('blockReorder', {
            data: {
                blockId: lastOp.blockId,
                fromIndex: lastOp.toIndex,
                toIndex: lastOp.fromIndex,
                reverted: true
            }
        });

        return true;
    }

    // ============================================
    // Event System
    // ============================================

    /** Subscribe to an event */
    on(event: VisualBridgeEventType, handler: VisualBridgeEventHandler): void {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event)!.push(handler);
    }

    /** Unsubscribe from an event */
    off(event: VisualBridgeEventType, handler: VisualBridgeEventHandler): void {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            const idx = handlers.indexOf(handler);
            if (idx > -1) handlers.splice(idx, 1);
        }
    }

    private emit(type: VisualBridgeEventType, data: Partial<VisualBridgeEvent> = {}): void {
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
                console.error('[DragDrop] Event handler error:', error);
            }
        });
    }

    // ============================================
    // CSS styles
    // ============================================

    private injectStyles(): void {
        if (this.styleElement) return;

        const style = document.createElement('style');
        style.id = 'inti-drag-drop-styles';
        style.textContent = `
            /* Ghost element styling during drag */
            [data-inti-block].inti-dd-dragging {
                opacity: ${this.config.ghostOpacity};
                outline: 2px dashed ${this.config.dropIndicatorColor};
                outline-offset: 2px;
                transition: opacity ${this.config.animationDuration}ms ease;
            }

            /* Drop indicator line */
            .inti-dd-drop-indicator {
                position: absolute;
                left: 0;
                right: 0;
                height: 4px;
                background: ${this.config.dropIndicatorColor};
                border-radius: 2px;
                pointer-events: none;
                z-index: 10001;
                opacity: 0;
                transition: opacity 150ms ease, top 100ms ease;
                box-shadow: 0 0 8px ${this.config.dropIndicatorColor}66;
            }
            .inti-dd-drop-indicator.inti-dd-visible {
                opacity: 1;
            }

            /* Smooth repositioning animation */
            [data-inti-block].inti-dd-animating {
                transition: transform ${this.config.animationDuration}ms ease;
            }

            /* Drag handle cursor */
            [data-inti-drag-handle],
            [data-inti-block][draggable="true"] {
                cursor: grab;
            }
            [data-inti-block].inti-dd-dragging {
                cursor: grabbing;
            }
        `;

        document.head.appendChild(style);
        this.styleElement = style;
    }

    // ============================================
    // Drop Indicator
    // ============================================

    private createDropIndicator(): void {
        const indicator = document.createElement('div');
        indicator.className = 'inti-dd-drop-indicator';
        document.body.appendChild(indicator);
        this.dropIndicator = indicator;
    }

    private showDropIndicator(targetElement: HTMLElement, position: 'before' | 'after'): void {
        if (!this.dropIndicator) return;

        const rect = targetElement.getBoundingClientRect();
        const scrollY = window.scrollY;

        let top: number;
        if (position === 'before') {
            top = rect.top + scrollY - 2;
        } else {
            top = rect.bottom + scrollY - 2;
        }

        this.dropIndicator.style.top = `${top}px`;
        this.dropIndicator.style.left = `${rect.left}px`;
        this.dropIndicator.style.width = `${rect.width}px`;
        this.dropIndicator.classList.add('inti-dd-visible');
    }

    private hideDropIndicator(): void {
        this.dropIndicator?.classList.remove('inti-dd-visible');
    }

    // ============================================
    // Block listeners
    // ============================================

    private getBlockElements(): HTMLElement[] {
        if (!this.container) return [];
        return Array.from(this.container.querySelectorAll<HTMLElement>('[data-inti-block]'));
    }

    private attachBlockListeners(): void {
        const blocks = this.getBlockElements();

        blocks.forEach(block => {
            // Only make it draggable if enabled
            if (this.config.enabled) {
                block.setAttribute('draggable', 'true');
            }

            const handlers: Record<string, EventListener> = {
                dragstart: (e: Event) => this.onDragStart(e as DragEvent, block),
                dragend: (e: Event) => this.onDragEnd(e as DragEvent, block),
                dragover: (e: Event) => this.onDragOver(e as DragEvent, block),
                dragleave: (e: Event) => this.onDragLeave(e as DragEvent, block),
                drop: (e: Event) => this.onDrop(e as DragEvent, block)
            };

            // If there is a drag handle, only start dragging from the handle
            if (this.config.handle) {
                const handle = block.querySelector(this.config.handle);
                if (handle) {
                    (handle as HTMLElement).addEventListener('mousedown', () => {
                        block.setAttribute('draggable', 'true');
                    });
                    (handle as HTMLElement).addEventListener('mouseup', () => {
                        if (!this.enabled) {
                            block.removeAttribute('draggable');
                        }
                    });
                }
            }

            Object.entries(handlers).forEach(([event, handler]) => {
                block.addEventListener(event, handler);
            });

            this.boundHandlers.set(block, handlers);
        });
    }

    private detachBlockListeners(): void {
        this.boundHandlers.forEach((handlers, block) => {
            Object.entries(handlers).forEach(([event, handler]) => {
                block.removeEventListener(event, handler);
            });
            block.removeAttribute('draggable');
        });
        this.boundHandlers.clear();
    }

    // ============================================
    // Drag Event Handlers
    // ============================================

    private onDragStart(event: DragEvent, element: HTMLElement): void {
        if (!this.enabled) {
            event.preventDefault();
            return;
        }

        this.draggedElement = element;
        this.draggedBlockId = element.dataset.intiBlockId || element.dataset.intiBlock || null;

        // Set up the transfer data
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', this.draggedBlockId || '');

            // Custom ghost (translucent clone)
            const ghost = element.cloneNode(true) as HTMLElement;
            ghost.style.opacity = String(this.config.ghostOpacity);
            ghost.style.position = 'absolute';
            ghost.style.top = '-9999px';
            document.body.appendChild(ghost);
            event.dataTransfer.setDragImage(ghost, 0, 0);

            // Clean up the ghost after a tick
            requestAnimationFrame(() => ghost.remove());
        }

        // Visual style of the dragged element
        element.classList.add('inti-dd-dragging');

        this.emit('blockMove', {
            data: {
                blockId: this.draggedBlockId,
                action: 'dragStart'
            }
        });
    }

    private onDragEnd(_event: DragEvent, element: HTMLElement): void {
        element.classList.remove('inti-dd-dragging');
        this.hideDropIndicator();
        this.draggedElement = null;
        this.draggedBlockId = null;
        this.dropTargetIndex = -1;
    }

    private onDragOver(event: DragEvent, element: HTMLElement): void {
        if (!this.enabled || !this.draggedElement || this.draggedElement === element) {
            return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }

        // Determine whether we are in the top or bottom half of the block
        const rect = element.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const position: 'before' | 'after' = event.clientY < midpoint ? 'before' : 'after';

        this.showDropIndicator(element, position);

        // Compute the target index
        const blocks = this.getBlockElements();
        const targetIdx = blocks.indexOf(element);
        this.dropTargetIndex = position === 'after' ? targetIdx + 1 : targetIdx;
    }

    private onDragLeave(_event: DragEvent, _element: HTMLElement): void {
        // Only hide if we really left the block (not a child)
        // Handled implicitly: the next dragover will show it again
    }

    private onDrop(event: DragEvent, _element: HTMLElement): void {
        event.preventDefault();
        this.hideDropIndicator();

        if (!this.enabled || !this.draggedElement || this.dropTargetIndex < 0) return;

        const blocks = this.getBlockElements();
        const fromIndex = blocks.indexOf(this.draggedElement);
        let toIndex = this.dropTargetIndex;

        // Adjust the index if we are moving down
        if (toIndex > fromIndex) {
            toIndex--;
        }

        // Do nothing if the position did not change
        if (fromIndex === toIndex || fromIndex < 0) {
            this.draggedElement.classList.remove('inti-dd-dragging');
            this.draggedElement = null;
            return;
        }

        // Save the previous order for undo
        const previousOrder = blocks.map(b => b.dataset.intiBlockId || b.dataset.intiBlock || '');
        const blockId = this.draggedBlockId || '';

        // Move in the DOM
        this.moveElementInDOM(this.draggedElement, fromIndex, toIndex);

        // Record in the undo stack
        this.undoStack.push({
            timestamp: Date.now(),
            blockId,
            fromIndex,
            toIndex,
            previousOrder
        });

        // Animate repositioned blocks
        this.animateBlocks();

        // Emit the reorder event
        this.emit('blockReorder', {
            data: {
                blockId,
                fromIndex,
                toIndex,
                newOrder: this.getBlockOrder()
            }
        });

        // Clean up
        this.draggedElement.classList.remove('inti-dd-dragging');
        this.draggedElement = null;
        this.draggedBlockId = null;
        this.dropTargetIndex = -1;
    }

    // ============================================
    // DOM manipulation
    // ============================================

    /**
     * Move a DOM element from one position to another within its parent.
     */
    private moveElementInDOM(element: HTMLElement, _fromIndex: number, toIndex: number): void {
        const parent = element.parentElement;
        if (!parent) return;

        const blocks = this.getBlockElements();
        const referenceBlock = blocks[toIndex];

        if (referenceBlock && referenceBlock !== element) {
            // If the target position comes after the dragged one, insert after
            const refIdx = blocks.indexOf(referenceBlock);
            const elemIdx = blocks.indexOf(element);
            if (refIdx > elemIdx) {
                parent.insertBefore(element, referenceBlock.nextSibling);
            } else {
                parent.insertBefore(element, referenceBlock);
            }
        } else if (toIndex >= blocks.length) {
            // Move to the end
            parent.appendChild(element);
        }
    }

    /**
     * Apply a specific block order to the DOM, based on an array of blockIds.
     */
    private applyOrder(blockIds: string[]): void {
        const parent = this.getBlockElements()[0]?.parentElement;
        if (!parent) return;

        const blockMap = new Map<string, HTMLElement>();
        this.getBlockElements().forEach(el => {
            const id = el.dataset.intiBlockId || el.dataset.intiBlock || '';
            blockMap.set(id, el);
        });

        // Reorder: insert in the desired order
        blockIds.forEach(id => {
            const el = blockMap.get(id);
            if (el) {
                parent.appendChild(el);
            }
        });

        this.animateBlocks();
    }

    /**
     * Briefly apply the animation class to every block.
     */
    private animateBlocks(): void {
        const blocks = this.getBlockElements();
        blocks.forEach(block => {
            block.classList.add('inti-dd-animating');
        });

        setTimeout(() => {
            blocks.forEach(block => {
                block.classList.remove('inti-dd-animating');
            });
        }, this.config.animationDuration);
    }

    // ============================================
    // Move a block programmatically (up/down)
    // ============================================

    /**
     * Move a block up or down by one position.
     * Used by the toolbar buttons.
     */
    moveBlockByDirection(element: HTMLElement, direction: 'up' | 'down'): boolean {
        const blocks = this.getBlockElements();
        const fromIndex = blocks.indexOf(element);
        if (fromIndex < 0) return false;

        const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
        if (toIndex < 0 || toIndex >= blocks.length) return false;

        // Save state for undo
        const previousOrder = blocks.map(b => b.dataset.intiBlockId || b.dataset.intiBlock || '');
        const blockId = element.dataset.intiBlockId || element.dataset.intiBlock || '';

        this.moveElementInDOM(element, fromIndex, toIndex);

        this.undoStack.push({
            timestamp: Date.now(),
            blockId,
            fromIndex,
            toIndex,
            previousOrder
        });

        this.animateBlocks();

        this.emit('blockReorder', {
            data: {
                blockId,
                fromIndex,
                toIndex,
                newOrder: this.getBlockOrder()
            }
        });

        return true;
    }
}
