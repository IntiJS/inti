/**
 * BlockReorder - Block drag & drop with write-back (client-side)
 *
 * Adds a drag handle to every block rendered by BlockRenderer.
 * On dropping it in another position:
 * 1. Optimistic DOM reorder (instant)
 * 2. POST to the `inti.moveBlock` action → the adapter reorders the array
 *    in the source CMS (ACF Flexible Content, Strapi dynamic zone,
 *    or the local store's blocks)
 * 3. If the write-back fails, the DOM is reverted
 *
 * It only allows reordering blocks of the same document.
 */

export interface BlockReorderConfig {
    /** HTTP endpoint of the action (default: '/_actions/inti.moveBlock') */
    actionPath?: string;
    /** Callback after each move */
    onMove?: (result: { success: boolean; fromIndex: number; toIndex: number; error?: string }) => void;
}

const HANDLE_CLASS = 'inti-drag-handle';
const DRAGGING_CLASS = 'inti-block-dragging';
const DROPZONE_CLASS = 'inti-block-dropzone';

export class BlockReorder {
    private actionPath: string;
    private config: BlockReorderConfig;
    private dragged: HTMLElement | null = null;

    constructor(config: BlockReorderConfig = {}) {
        this.config = config;
        this.actionPath = config.actionPath || '/_actions/inti.moveBlock';
    }

    init(): this {
        this.injectStyles();
        this.scan();
        return this;
    }

    rescan(): void {
        this.scan();
    }

    private scan(): void {
        document.querySelectorAll<HTMLElement>('[data-inti-block]').forEach(wrapper => {
            if (wrapper.dataset.intiReorderBound === 'true') return;
            wrapper.dataset.intiReorderBound = 'true';

            this.attachHandle(wrapper);
            this.attachDropTarget(wrapper);
        });
    }

    private injectStyles(): void {
        if (document.getElementById('inti-reorder-styles')) return;

        const style = document.createElement('style');
        style.id = 'inti-reorder-styles';
        style.textContent = `
            [data-inti-block] { position: relative; }
            .${HANDLE_CLASS} {
                position: absolute;
                top: 0.4rem;
                left: 0.4rem;
                width: 1.6rem;
                height: 1.6rem;
                display: none;
                align-items: center;
                justify-content: center;
                background: rgba(30, 41, 59, 0.85);
                color: #e2e8f0;
                border-radius: 0.35rem;
                cursor: grab;
                font-size: 0.9rem;
                line-height: 1;
                user-select: none;
                z-index: 99999;
            }
            [data-inti-block]:hover > .${HANDLE_CLASS} { display: flex; }
            .${HANDLE_CLASS}:active { cursor: grabbing; }
            .${DRAGGING_CLASS} { opacity: 0.4; }
            .${DROPZONE_CLASS} { box-shadow: 0 -3px 0 0 #3b82f6; }
        `;
        document.head.appendChild(style);
    }

    private attachHandle(wrapper: HTMLElement): void {
        const handle = document.createElement('div');
        handle.className = HANDLE_CLASS;
        handle.textContent = '⠿';
        handle.title = 'Drag to reorder';
        handle.setAttribute('aria-label', 'Drag to reorder');
        handle.draggable = true;

        handle.addEventListener('dragstart', (event) => {
            this.dragged = wrapper;
            wrapper.classList.add(DRAGGING_CLASS);
            event.dataTransfer?.setData('text/plain', wrapper.dataset.intiBlockIndex ?? '');
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });

        handle.addEventListener('dragend', () => {
            wrapper.classList.remove(DRAGGING_CLASS);
            document.querySelectorAll(`.${DROPZONE_CLASS}`).forEach(el => el.classList.remove(DROPZONE_CLASS));
            this.dragged = null;
        });

        wrapper.appendChild(handle);
    }

    private attachDropTarget(wrapper: HTMLElement): void {
        wrapper.addEventListener('dragover', (event) => {
            if (!this.dragged || this.dragged === wrapper) return;
            // Only within the same document
            if (this.dragged.dataset.intiDocumentId !== wrapper.dataset.intiDocumentId) return;

            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            wrapper.classList.add(DROPZONE_CLASS);
        });

        wrapper.addEventListener('dragleave', () => {
            wrapper.classList.remove(DROPZONE_CLASS);
        });

        wrapper.addEventListener('drop', (event) => {
            wrapper.classList.remove(DROPZONE_CLASS);
            if (!this.dragged || this.dragged === wrapper) return;

            event.preventDefault();
            void this.performMove(this.dragged, wrapper);
        });
    }

    private async performMove(dragged: HTMLElement, target: HTMLElement): Promise<void> {
        const documentId = dragged.dataset.intiDocumentId;
        const fromIndex = parseInt(dragged.dataset.intiBlockIndex ?? '', 10);
        const toIndex = parseInt(target.dataset.intiBlockIndex ?? '', 10);

        if (!documentId || Number.isNaN(fromIndex) || Number.isNaN(toIndex)) return;

        // 1. Optimistic DOM reorder
        const parent = dragged.parentElement;
        const nextSibling = dragged.nextElementSibling;
        if (fromIndex < toIndex) {
            target.after(dragged);
        } else {
            target.before(dragged);
        }
        this.renumber(documentId);

        // 2. Write-back
        try {
            const response = await fetch(this.actionPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentId, fromIndex, toIndex })
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`${response.status} ${body.slice(0, 150)}`);
            }

            this.toast('Order saved ✓', 'success');
            this.config.onMove?.({ success: true, fromIndex, toIndex });
        } catch (error) {
            // 3. DOM revert
            if (nextSibling) {
                nextSibling.before(dragged);
            } else {
                parent?.appendChild(dragged);
            }
            this.renumber(documentId);

            const message = error instanceof Error ? error.message : String(error);
            this.toast(`Could not reorder: ${message}`, 'error');
            this.config.onMove?.({ success: false, fromIndex, toIndex, error: message });
        }
    }

    /** Re-syncs data-inti-block-index with the real DOM order */
    private renumber(documentId: string): void {
        const wrappers = document.querySelectorAll<HTMLElement>(
            `[data-inti-block][data-inti-document-id="${documentId}"]`
        );
        wrappers.forEach((wrapper, i) => {
            wrapper.dataset.intiBlockIndex = String(i);
        });
    }

    private toast(message: string, type: 'success' | 'error'): void {
        document.querySelector('.inti-inline-toast')?.remove();

        const toast = document.createElement('div');
        toast.className = 'inti-inline-toast';
        toast.textContent = message;
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.style.cssText = [
            'position: fixed',
            'bottom: 1.5rem',
            'left: 50%',
            'transform: translateX(-50%)',
            `background: ${type === 'success' ? '#16a34a' : '#dc2626'}`,
            'color: white',
            'padding: 0.5rem 1rem',
            'border-radius: 0.5rem',
            'font-size: 0.875rem',
            'font-family: system-ui, sans-serif',
            'box-shadow: 0 4px 12px rgba(0,0,0,0.25)',
            'z-index: 9999999',
            'pointer-events: none'
        ].join(';');

        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2800);
    }
}

let globalBlockReorder: BlockReorder | null = null;

/** Initializes (or returns) the global block reorderer */
export function initBlockReorder(config?: BlockReorderConfig): BlockReorder {
    if (!globalBlockReorder) {
        globalBlockReorder = new BlockReorder(config).init();
    }
    return globalBlockReorder;
}
