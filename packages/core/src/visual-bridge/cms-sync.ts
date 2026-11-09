/**
 * CmsSyncManager - CMS sync layer for Visual Bridge
 * 
 * Manages a queue of operations (reorder, delete, duplicate, update)
 * with automatic retries, exponential backoff, and support for 
 * optimistic updates with rollback on error.
 */

import type {
    CmsConnector,
    CmsSyncOperation,
    BridgeBlockInfo,
    VisualBridgeEventType,
    VisualBridgeEventHandler,
    VisualBridgeEvent
} from './types.js';

// ============================================
// Internal types
// ============================================

/** State of an operation in the queue */
interface QueuedOperation {
    /** Operation to run */
    operation: CmsSyncOperation;
    /** Number of attempts made */
    retries: number;
    /** Whether it is being processed */
    processing: boolean;
    /** Enqueue timestamp */
    queuedAt: number;
    /** Rollback callback for optimistic UI */
    rollback?: () => void;
}

/** Queue state */
export interface QueueStatus {
    /** Number of pending operations */
    pending: number;
    /** Number of operations being processed */
    processing: number;
    /** Number of failed operations */
    failed: number;
    /** Whether the queue is active */
    isProcessing: boolean;
}

// ============================================
// Constants
// ============================================

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

// ============================================
// CmsSyncManager
// ============================================

export class CmsSyncManager {
    private connector: CmsConnector;
    private queue: QueuedOperation[] = [];
    private failedOps: QueuedOperation[] = [];
    private isProcessing: boolean = false;
    private eventHandlers: Map<VisualBridgeEventType, VisualBridgeEventHandler[]> = new Map();

    constructor(connector: CmsConnector) {
        this.connector = connector;
    }

    // ============================================
    // Public API
    // ============================================

    /**
     * Enqueue a sync operation with the CMS.
     * If a `rollback` is provided, it runs on error (optimistic UI).
     * 
     * @param operation - The CMS operation to run
     * @param rollback  - Optional rollback function to undo optimistic changes
     */
    queueOperation(operation: CmsSyncOperation, rollback?: () => void): void {
        this.queue.push({
            operation,
            retries: 0,
            processing: false,
            queuedAt: Date.now(),
            rollback
        });

        this.emit('syncStart', {
            data: { operation, queueLength: this.queue.length }
        });

        // Process automatically
        this.processQueue();
    }

    /**
     * Force processing of all pending operations.
     */
    async flush(): Promise<void> {
        await this.processQueue();
    }

    /**
     * Get the current queue state.
     */
    getQueueStatus(): QueueStatus {
        return {
            pending: this.queue.filter(op => !op.processing).length,
            processing: this.queue.filter(op => op.processing).length,
            failed: this.failedOps.length,
            isProcessing: this.isProcessing
        };
    }

    /**
     * Clear the queue of pending and failed operations.
     */
    clearQueue(): void {
        this.queue = [];
        this.failedOps = [];
        this.isProcessing = false;
    }

    // ============================================
    // Event System
    // ============================================

    /** Subscribe to a sync event */
    on(event: VisualBridgeEventType, handler: VisualBridgeEventHandler): void {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event)!.push(handler);
    }

    /** Unsubscribe from a sync event */
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
                console.error('[CmsSync] Event handler error:', error);
            }
        });
    }

    // ============================================
    // Queue processing
    // ============================================

    private async processQueue(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const queued = this.queue[0];
            queued.processing = true;

            try {
                await this.executeOperation(queued.operation);

                // Success: remove from the queue
                this.queue.shift();

                this.emit('syncSuccess', {
                    data: {
                        operation: queued.operation,
                        remainingQueue: this.queue.length
                    }
                });
            } catch (error) {
                queued.retries++;

                if (queued.retries >= MAX_RETRIES) {
                    // Move to failed and run the rollback
                    this.queue.shift();
                    this.failedOps.push(queued);

                    if (queued.rollback) {
                        try {
                            queued.rollback();
                        } catch (rollbackError) {
                            console.error('[CmsSync] Rollback error:', rollbackError);
                        }
                    }

                    this.emit('syncError', {
                        data: {
                            operation: queued.operation,
                            error: error instanceof Error ? error.message : String(error),
                            retriesExhausted: true
                        }
                    });
                } else {
                    // Retry with exponential backoff
                    queued.processing = false;
                    const delay = BASE_BACKOFF_MS * Math.pow(2, queued.retries - 1);

                    this.emit('syncRetry', {
                        data: {
                            operation: queued.operation,
                            retry: queued.retries,
                            maxRetries: MAX_RETRIES,
                            nextRetryMs: delay
                        }
                    });

                    await this.sleep(delay);
                }
            }
        }

        this.isProcessing = false;
    }

    // ============================================
    // Operation execution
    // ============================================

    private async executeOperation(operation: CmsSyncOperation): Promise<void> {
        switch (operation.type) {
            case 'reorder':
                if (!this.connector.reorderBlocks) {
                    throw new Error(`CMS connector "${this.connector.name}" does not support reorderBlocks`);
                }
                await this.connector.reorderBlocks(
                    operation.documentId,
                    operation.blockIds!
                );
                break;

            case 'delete':
                if (!this.connector.deleteBlock) {
                    throw new Error(`CMS connector "${this.connector.name}" does not support deleteBlock`);
                }
                await this.connector.deleteBlock(
                    operation.documentId,
                    operation.blockId!
                );
                break;

            case 'duplicate':
                if (!this.connector.duplicateBlock) {
                    throw new Error(`CMS connector "${this.connector.name}" does not support duplicateBlock`);
                }
                await this.connector.duplicateBlock(
                    operation.documentId,
                    operation.blockId!
                );
                break;

            case 'update':
                // Generic update: would require fetchLatest or another mechanism
                console.warn('[CmsSync] Update operations are connector-specific');
                break;

            default:
                throw new Error(`Unknown operation type: ${(operation as any).type}`);
        }
    }

    // ============================================
    // Utilities
    // ============================================

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
