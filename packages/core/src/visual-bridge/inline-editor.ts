/**
 * InlineEditor - Real inline editing on the page (client-side)
 *
 * Unlike VisualBridge's classic overlay (which navigates to the CMS
 * admin), this module lets you edit text DIRECTLY on the Astro page
 * and persists the change via write-back:
 *
 *   dblclick on a field → contenteditable → blur/Enter →
 *   POST to the `inti.updateBlockField` action (server-side) →
 *   the adapter writes back to the source CMS (WordPress, Kitsuden, Strapi or the local store)
 *
 * Field binding (two mechanisms, combinable):
 * 1. Explicit: the component marks elements with `data-inti-field="heading"`
 * 2. Auto-bind: BlockRenderer emits a <script type="application/json"
 *    data-inti-block-json> with the block's data; the editor matches
 *    string values against the text of the block's leaf elements.
 *
 * Saving is optimistic: the DOM already shows the new value; if the
 * write-back fails it is reverted and a toast reports it.
 */

import { EditHistory } from './edit-history.js';
import type { EditRecord } from './edit-history.js';

// ============================================
// Types
// ============================================

export interface InlineEditorConfig {
    /** HTTP endpoint of the write-back action (default: '/_actions/inti.updateBlockField') */
    actionPath?: string;
    /** Search endpoint for the relation picker (default: '/api/inti/search') */
    searchPath?: string;
    /** Try to auto-bind fields by text matching (default: true) */
    autoBind?: boolean;
    /** Maximum length of a string value for it to count as auto-bindable */
    maxAutoBindLength?: number;
    /** Callback after each save (success or failure) */
    onSave?: (result: InlineSaveResult) => void;
}

export interface InlineSaveResult {
    success: boolean;
    documentId: string;
    blockIndex: number;
    field: string;
    value: string;
    error?: string;
}

// ============================================
// Helpers
// ============================================

/** Flattens an object into [dot-path, value] pairs, string leaves only */
function flattenStrings(data: any, prefix = ''): Array<[string, string]> {
    const out: Array<[string, string]> = [];

    if (data === null || typeof data !== 'object') return out;

    for (const [key, value] of Object.entries(data)) {
        const path = prefix ? `${prefix}.${key}` : key;

        if (typeof value === 'string') {
            out.push([path, value]);
        } else if (value && typeof value === 'object') {
            out.push(...flattenStrings(value, path));
        }
    }

    return out;
}

// ============================================
// InlineEditor
// ============================================

/**
 * The block wrapper an element belongs to: the closest one.
 * `closest` includes the element itself, which is what is wanted when the
 * element is itself a nested wrapper.
 */
function ownerWrapper(el: Element): HTMLElement | null {
    return el.closest<HTMLElement>('[data-inti-block]');
}

export class InlineEditor {
    private config: Required<Pick<InlineEditorConfig, 'actionPath' | 'searchPath' | 'autoBind' | 'maxAutoBindLength'>> & InlineEditorConfig;
    private editing = false;
    private history = new EditHistory<HTMLElement>();

    constructor(config: InlineEditorConfig = {}) {
        this.config = {
            actionPath: config.actionPath || '/_actions/inti.updateBlockField',
            searchPath: config.searchPath || '/api/inti/search',
            autoBind: config.autoBind !== false,
            maxAutoBindLength: config.maxAutoBindLength || 500,
            onSave: config.onSave
        };
    }

    /** Scans the DOM and binds every editable field */
    init(): this {
        this.scan();
        document.addEventListener('keydown', this.onHistoryKey);
        return this;
    }

    /** Rescans (useful after view transitions or DOM changes) */
    rescan(): void {
        this.scan();
    }

    private scan(): void {
        const wrappers = document.querySelectorAll<HTMLElement>('[data-inti-block]');

        wrappers.forEach(wrapper => {
            // A block without a document cannot be saved: commit() would not know
            // where to write. It happens with a nested BlockRenderer, whose children
            // are data of the parent block, not CMS blocks. Offering editing
            // there opens a mode that never leads anywhere, so it is not offered.
            if (!wrapper.dataset.intiDocumentId) return;

            // 1. Explicit bindings from the component author
            wrapper.querySelectorAll<HTMLElement>('[data-inti-field]').forEach(el => {
                // Only the fields whose CLOSEST wrapper is this one. With a
                // nested BlockRenderer, a field of the child block is also a
                // descendant of the parent, and the parent is walked first:
                // binding it here would write the child's text into the parent's
                // field of the same name, showing "saved".
                if (ownerWrapper(el) !== wrapper) return;
                this.bind(el, wrapper);
            });

            // 2. Auto-bind from the data serialized by BlockRenderer
            if (this.config.autoBind) {
                this.autoBindWrapper(wrapper);
            }
        });
    }

    private autoBindWrapper(wrapper: HTMLElement): void {
        const script = wrapper.querySelector<HTMLScriptElement>('script[data-inti-block-json]');
        if (!script?.textContent) return;

        let data: any;
        try {
            data = JSON.parse(script.textContent);
        } catch {
            return;
        }

        for (const [path, value] of flattenStrings(data)) {
            const trimmed = value.trim();
            if (!trimmed || trimmed.length > this.config.maxAutoBindLength) continue;
            // Values with markup are not auto-editable as plain text
            if (/<[a-z][\s\S]*>/i.test(trimmed)) continue;

            const el = this.findLeafByText(wrapper, trimmed);
            if (el) {
                if (!el.hasAttribute('data-inti-field')) {
                    el.setAttribute('data-inti-field', path);
                }
                this.bind(el, wrapper);
            }
        }
    }

    /** Finds the leaf element whose text exactly matches the value */
    private findLeafByText(wrapper: HTMLElement, text: string): HTMLElement | null {
        const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_ELEMENT);
        let match: HTMLElement | null = null;

        let node = walker.nextNode() as HTMLElement | null;
        while (node) {
            const tag = node.tagName;
            if (
                tag !== 'SCRIPT' &&
                tag !== 'STYLE' &&
                node.textContent?.trim() === text &&
                // The text of a nested block does not belong to this block
                ownerWrapper(node) === wrapper
            ) {
                // Prefer the deepest element that contains exactly the text
                match = node;
            }
            node = walker.nextNode() as HTMLElement | null;
        }

        return match;
    }

    private bind(el: HTMLElement, wrapper: HTMLElement): void {
        if (el.dataset.intiBound === 'true') return;
        el.dataset.intiBound = 'true';

        el.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();

            // Relation fields open the picker; the rest, contenteditable
            if (el.dataset.intiRelation) {
                this.openRelationPicker(el, wrapper);
            } else {
                this.startEditing(el, wrapper);
            }
        });

        // Subtle visual affordance on hover
        el.addEventListener('mouseenter', () => {
            if (!this.editing) el.style.outline = '1px dashed rgba(59, 130, 246, 0.5)';
        });
        el.addEventListener('mouseleave', () => {
            if (el.contentEditable !== 'true' && el.contentEditable !== 'plaintext-only') {
                el.style.outline = '';
            }
        });
    }

    private startEditing(el: HTMLElement, wrapper: HTMLElement): void {
        if (this.editing) return;
        this.editing = true;

        const original = el.textContent ?? '';

        // plaintext-only prevents pasting HTML; Firefox does not support it → fallback
        el.contentEditable = 'plaintext-only';
        if (el.contentEditable !== 'plaintext-only') {
            el.contentEditable = 'true';
        }
        el.style.outline = '2px solid rgba(59, 130, 246, 0.9)';
        el.style.outlineOffset = '2px';
        el.focus();

        // Select all the content for quick replacement
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        const cleanup = () => {
            el.contentEditable = 'false';
            el.removeAttribute('contenteditable');
            el.style.outline = '';
            el.style.outlineOffset = '';
            el.removeEventListener('keydown', onKeydown);
            el.removeEventListener('blur', onBlur);
            this.editing = false;
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                el.textContent = original;
                el.blur();
            } else if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                el.blur(); // blur triggers the commit
            }
        };

        const onBlur = () => {
            const value = el.textContent ?? '';
            cleanup();

            if (value !== original) {
                void this.commit(el, wrapper, original, value);
            }
        };

        el.addEventListener('keydown', onKeydown);
        el.addEventListener('blur', onBlur);
    }

    /** Optimistic save: the DOM already shows `value`; if it fails, it reverts */
    private async commit(el: HTMLElement, wrapper: HTMLElement, original: string, value: string): Promise<void> {
        const documentId = wrapper.dataset.intiDocumentId;
        const blockIndex = parseInt(wrapper.dataset.intiBlockIndex ?? '', 10);
        const field = el.dataset.intiField;

        if (!documentId || Number.isNaN(blockIndex) || !field) {
            el.textContent = original;
            this.toast('Could not identify the field (data attributes missing)', 'error');
            return;
        }

        const result: InlineSaveResult = { success: false, documentId, blockIndex, field, value };

        try {
            const response = await fetch(this.config.actionPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentId, blockIndex, field, value })
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`${response.status} ${body.slice(0, 150)}`);
            }

            result.success = true;
            this.history.record({ documentId, blockIndex, field, previous: original, value, target: el });
            this.flash(el, 'rgba(34, 197, 94, 0.7)');
            this.toast('Saved ✓', 'success', { label: 'Undo', run: () => void this.undo() });
        } catch (error) {
            result.error = error instanceof Error ? error.message : String(error);
            el.textContent = original; // revert
            this.flash(el, 'rgba(239, 68, 68, 0.7)');
            this.toast(`Could not save: ${result.error}`, 'error');
        }

        this.config.onSave?.(result);
    }

    // ============================================
    // Undo / redo
    // ============================================

    /** Writes a previous value again: a normal write, with its permissions */
    private writeHistory = async (edit: EditRecord<HTMLElement>, value: string): Promise<void> => {
        const response = await fetch(this.config.actionPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: edit.documentId,
                blockIndex: edit.blockIndex,
                field: edit.field,
                value
            })
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`${response.status} ${body.slice(0, 150)}`);
        }

        edit.target.textContent = value;
        this.flash(edit.target, 'rgba(34, 197, 94, 0.7)');
    };

    async undo(): Promise<void> {
        try {
            if (await this.history.undo(this.writeHistory)) {
                this.toast('Undone', 'success', { label: 'Redo', run: () => void this.redo() });
            }
        } catch (error) {
            this.toast(`Could not undo: ${error instanceof Error ? error.message : error}`, 'error');
        }
    }

    async redo(): Promise<void> {
        try {
            if (await this.history.redo(this.writeHistory)) {
                this.toast('Redone', 'success', { label: 'Undo', run: () => void this.undo() });
            }
        } catch (error) {
            this.toast(`Could not redo: ${error instanceof Error ? error.message : error}`, 'error');
        }
    }

    /** Ctrl/Cmd+Z outside a field: inside one, the browser itself undoes */
    private onHistoryKey = (event: KeyboardEvent): void => {
        if (this.editing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;

        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable || active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;
        if (event.shiftKey ? !this.history.canRedo : !this.history.canUndo) return;

        event.preventDefault();
        void (event.shiftKey ? this.redo() : this.undo());
    };

    // ============================================
    // Relation picker (mini-panel)
    // ============================================

    /**
     * Search panel for relation fields.
     *
     * The component marks the field with:
     *   <span data-inti-field="author" data-inti-relation="users">Ana</span>
     * where data-inti-relation is the collection to search for candidates.
     *
     * On selecting: updateBlockField with the chosen ID, and the element's
     * text is updated to the title (optimistic).
     */
    private openRelationPicker(el: HTMLElement, wrapper: HTMLElement): void {
        if (this.editing) return;
        this.editing = true;

        const collection = el.dataset.intiRelation!;
        const rect = el.getBoundingClientRect();

        const panel = document.createElement('div');
        panel.className = 'inti-relation-panel';
        panel.style.cssText = [
            'position: fixed',
            `top: ${Math.min(rect.bottom + 6, window.innerHeight - 320)}px`,
            `left: ${Math.min(rect.left, window.innerWidth - 320)}px`,
            'width: 300px',
            'max-height: 300px',
            'background: #1e293b',
            'color: #e2e8f0',
            'border-radius: 0.5rem',
            'box-shadow: 0 8px 24px rgba(0,0,0,0.4)',
            'font-family: system-ui, sans-serif',
            'font-size: 0.875rem',
            'z-index: 9999999',
            'display: flex',
            'flex-direction: column',
            'overflow: hidden'
        ].join(';');

        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = `Search in ${collection}…`;
        input.setAttribute('aria-label', input.placeholder);
        input.style.cssText = 'margin:0.5rem;padding:0.4rem 0.6rem;border:1px solid #475569;border-radius:0.35rem;background:#0f172a;color:#e2e8f0;outline-color:#93c5fd;';

        const list = document.createElement('div');
        list.style.cssText = 'overflow-y:auto;padding:0 0.5rem 0.5rem;';

        panel.append(input, list);
        document.body.appendChild(panel);
        input.focus();

        const close = () => {
            panel.remove();
            document.removeEventListener('mousedown', onOutside, true);
            this.editing = false;
        };

        const onOutside = (event: MouseEvent) => {
            if (!panel.contains(event.target as Node)) close();
        };
        document.addEventListener('mousedown', onOutside, true);

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close();
        });

        const renderResults = (entries: Array<{ id: string; title: string; subtitle?: string }>) => {
            list.innerHTML = '';

            if (entries.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = 'No results';
                empty.style.cssText = 'padding:0.5rem;color:#94a3b8;';
                list.appendChild(empty);
                return;
            }

            for (const entry of entries) {
                const item = document.createElement('button');
                item.type = 'button';
                item.style.cssText = 'display:block;width:100%;text-align:left;padding:0.45rem 0.6rem;border:none;background:transparent;color:inherit;border-radius:0.35rem;cursor:pointer;';
                // Titles come from the CMS: they are text, never markup
                const title = document.createElement('div');
                title.textContent = entry.title;
                item.appendChild(title);
                if (entry.subtitle) {
                    const subtitle = document.createElement('div');
                    subtitle.style.cssText = 'color:#94a3b8;font-size:0.75rem;';
                    subtitle.textContent = entry.subtitle;
                    item.appendChild(subtitle);
                }
                item.addEventListener('mouseenter', () => { item.style.background = '#334155'; });
                item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
                item.addEventListener('click', () => {
                    close();
                    void this.commitRelation(el, wrapper, entry);
                });
                list.appendChild(item);
            }
        };

        let debounce: ReturnType<typeof setTimeout> | undefined;
        const search = async (query: string) => {
            try {
                const params = new URLSearchParams({ collection, q: query });
                const response = await fetch(`${this.config.searchPath}?${params}`);
                if (!response.ok) throw new Error(`${response.status}`);
                renderResults(await response.json());
            } catch {
                renderResults([]);
            }
        };

        input.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => void search(input.value), 250);
        });

        void search('');
    }

    /** Saves the chosen relation (the value is the entry's ID) */
    private async commitRelation(el: HTMLElement, wrapper: HTMLElement, entry: { id: string; title: string }): Promise<void> {
        const original = el.textContent ?? '';
        el.textContent = entry.title; // optimistic

        const documentId = wrapper.dataset.intiDocumentId;
        const blockIndex = parseInt(wrapper.dataset.intiBlockIndex ?? '', 10);
        const field = el.dataset.intiField;

        if (!documentId || Number.isNaN(blockIndex) || !field) {
            el.textContent = original;
            this.toast('Could not identify the field', 'error');
            return;
        }

        // Numeric IDs travel as numbers (ACF relationship expects them that way)
        const value = /^\d+$/.test(entry.id) ? Number(entry.id) : entry.id;
        const result: InlineSaveResult = { success: false, documentId, blockIndex, field, value: entry.id };

        try {
            const response = await fetch(this.config.actionPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentId, blockIndex, field, value })
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`${response.status} ${body.slice(0, 150)}`);
            }

            result.success = true;
            this.flash(el, 'rgba(34, 197, 94, 0.7)');
            this.toast('Relation saved ✓', 'success');
        } catch (error) {
            result.error = error instanceof Error ? error.message : String(error);
            el.textContent = original;
            this.flash(el, 'rgba(239, 68, 68, 0.7)');
            this.toast(`Could not save: ${result.error}`, 'error');
        }

        this.config.onSave?.(result);
    }

    /** Brief visual feedback on the edited element */
    private flash(el: HTMLElement, color: string): void {
        el.style.transition = 'outline-color 0.3s ease';
        el.style.outline = `2px solid ${color}`;
        el.style.outlineOffset = '2px';
        setTimeout(() => {
            el.style.outline = '';
            el.style.outlineOffset = '';
        }, 1200);
    }

    private toast(message: string, type: 'success' | 'error', action?: { label: string; run: () => void }): void {
        const existing = document.querySelector('.inti-inline-toast');
        existing?.remove();

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
            // Only captures clicks if there is something to press
            `pointer-events: ${action ? 'auto' : 'none'}`
        ].join(';');

        if (action) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.label;
            button.style.cssText =
                'margin-left: 0.75rem; background: rgba(255,255,255,0.2); color: inherit; border: 0; border-radius: 0.25rem; padding: 0.125rem 0.5rem; font: inherit; cursor: pointer;';
            button.addEventListener('click', () => {
                toast.remove();
                action.run();
            });
            toast.appendChild(button);
        }

        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), action ? 6000 : 2800);
    }
}

// ============================================
// Public API
// ============================================

let globalInlineEditor: InlineEditor | null = null;

/** Initializes (or returns) the global inline editor */
export function initInlineEditor(config?: InlineEditorConfig): InlineEditor {
    if (!globalInlineEditor) {
        globalInlineEditor = new InlineEditor(config).init();
    }
    return globalInlineEditor;
}

export function getInlineEditor(): InlineEditor | null {
    return globalInlineEditor;
}
