/**
 * BlockComposer - Visual page composition (client-side)
 *
 * Turns the editing layer into a component-based builder:
 * - Per-block toolbar: add (＋), settings (⚙), duplicate (⧉), delete (✕)
 * - Block palette: types declared by the dev + detected on the page
 * - Settings panel: form inferred from the block's data
 *   (with selects for the variants declared by the dev)
 * - Patterns: saved, reinsertable groups of blocks (localStorage)
 *
 * Philosophy (Inti's moat against Elementor/Oxygen):
 * the developer defines the block vocabulary in code (power);
 * the editor composes with that vocabulary (simplicity). Never free-form CSS.
 */

// ============================================
// Types
// ============================================

/** Block type available in the palette, declared by the dev */
export interface ComposerBlockType {
    /** Native CMS identifier (acf_fc_layout, uid __component, local type) */
    nativeType: string;
    /** Name shown in the palette */
    label: string;
    /** What it is for, and when it fits. Used by assisted generation */
    description?: string;
    when?: string;
    /** Fields that assisted generation can fill in (see @intijs/genui) */
    fields?: Record<string, any>;
    /** Initial data on insert */
    defaults?: Record<string, any>;
    /**
     * Controlled variants: field → options.
     * The settings panel shows them as a select.
     * E.g.: { variant: ['dark', 'light'], layout: ['split', 'stacked'] }
     */
    variants?: Record<string, string[]>;
}

export interface BlockComposerConfig {
    /** Base of the actions (default: '/_actions/inti.') */
    actionBase?: string;
    /** Block types available in the palette */
    blockTypes?: ComposerBlockType[];
}

interface SavedPattern {
    name: string;
    blocks: Array<{ nativeType: string; data: Record<string, any> }>;
}

const PATTERNS_KEY = 'inti-patterns';

// ============================================
// BlockComposer
// ============================================

export class BlockComposer {
    private actionBase: string;
    private blockTypes: ComposerBlockType[];
    private overlay: HTMLElement | null = null;
    /** true if the server provides a shared pattern store (@intijs/core/team) */
    private patternsAreShared = false;
    /** The server's generation capability; undefined = not probed yet */
    private aiIsAvailable: boolean | undefined;
    private generatePath = '/api/inti/generate';
    private previewPath = '/api/inti/preview';

    constructor(config: BlockComposerConfig = {}) {
        this.actionBase = config.actionBase || '/_actions/inti.';
        this.blockTypes = config.blockTypes || [];
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
            if (wrapper.dataset.intiComposerBound === 'true') return;
            wrapper.dataset.intiComposerBound = 'true';
            this.attachToolbar(wrapper);
        });
    }

    // ============================================
    // Palette: available types
    // ============================================

    /** Dev-declared + detected on the page (deduplicated) */
    private availableTypes(): ComposerBlockType[] {
        const seen = new Map<string, ComposerBlockType>();

        for (const type of this.blockTypes) {
            seen.set(type.nativeType, type);
        }

        document.querySelectorAll<HTMLElement>('[data-inti-block]').forEach(wrapper => {
            const native = wrapper.dataset.intiBlockLabel;
            const display = wrapper.dataset.intiBlock;
            // Gutenberg blocks are not insertable (no template)
            if (!native || native.startsWith('gutenberg:') || seen.has(native)) return;
            seen.set(native, { nativeType: native, label: display || native });
        });

        return [...seen.values()];
    }

    private typeMeta(nativeType: string): ComposerBlockType | undefined {
        return this.blockTypes.find(t => t.nativeType === nativeType);
    }

    // ============================================
    // Per-block toolbar
    // ============================================

    private attachToolbar(wrapper: HTMLElement): void {
        const bar = document.createElement('div');
        bar.className = 'inti-composer-bar';

        const btn = (icon: string, title: string, onClick: () => void) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = icon;
            b.title = title;
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            bar.appendChild(b);
        };

        btn('＋', 'Add block below', () => this.openPalette(wrapper));
        btn('⚙', 'Block settings', () => this.openSettings(wrapper));
        btn('⧉', 'Duplicate block', () => void this.duplicate(wrapper));
        btn('☆', 'Save page as pattern', () => void this.savePagePattern(wrapper));
        btn('✕', 'Delete block', () => void this.remove(wrapper));

        wrapper.appendChild(bar);
    }

    // ============================================
    // Operations (optimistic where the DOM allows it)
    // ============================================

    private ctx(wrapper: HTMLElement): { documentId: string; index: number } | null {
        const documentId = wrapper.dataset.intiDocumentId;
        const index = parseInt(wrapper.dataset.intiBlockIndex ?? '', 10);
        if (!documentId || Number.isNaN(index)) return null;
        return { documentId, index };
    }

    private async post(action: string, body: Record<string, any>): Promise<any> {
        const response = await fetch(`${this.actionBase}${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`${response.status} ${text.slice(0, 150)}`);
        }

        // Block actions return no useful body; pattern actions do
        return response.json().catch(() => null);
    }

    private async remove(wrapper: HTMLElement): Promise<void> {
        const ctx = this.ctx(wrapper);
        if (!ctx) return;
        if (!confirm('Delete this block?')) return;

        // Optimistic: remove from the DOM and renumber
        const parent = wrapper.parentElement;
        const next = wrapper.nextElementSibling;
        wrapper.remove();
        this.renumber(ctx.documentId);

        try {
            await this.post('removeBlock', { documentId: ctx.documentId, index: ctx.index });
            this.toast('Block deleted ✓', 'success');
        } catch (error) {
            // Revert
            if (next) next.before(wrapper); else parent?.appendChild(wrapper);
            this.renumber(ctx.documentId);
            this.toast(`Could not delete: ${error instanceof Error ? error.message : error}`, 'error');
        }
    }

    private async duplicate(wrapper: HTMLElement): Promise<void> {
        const ctx = this.ctx(wrapper);
        if (!ctx) return;

        try {
            await this.post('duplicateBlock', { documentId: ctx.documentId, index: ctx.index });
            this.toast('Block duplicated ✓ — reloading…', 'success');
            setTimeout(() => window.location.reload(), 700);
        } catch (error) {
            this.toast(`Could not duplicate: ${error instanceof Error ? error.message : error}`, 'error');
        }
    }

    private async insert(wrapper: HTMLElement, type: ComposerBlockType): Promise<void> {
        const ctx = this.ctx(wrapper);
        if (!ctx) return;

        try {
            await this.post('insertBlock', {
                documentId: ctx.documentId,
                index: ctx.index + 1,
                nativeType: type.nativeType,
                data: type.defaults || {}
            });
            this.toast(`Block "${type.label}" added ✓ — reloading…`, 'success');
            setTimeout(() => window.location.reload(), 700);
        } catch (error) {
            this.toast(`Could not add: ${error instanceof Error ? error.message : error}`, 'error');
        }
    }

    // ============================================
    // Palette (blocks + patterns)
    // ============================================

    private openPalette(wrapper: HTMLElement): void {
        this.closeOverlay();

        const panel = this.panelShell('Add block');
        const tabs = document.createElement('div');
        tabs.className = 'inti-composer-tabs';
        const blocksTab = document.createElement('button');
        blocksTab.textContent = 'Blocks';
        const patternsTab = document.createElement('button');
        patternsTab.textContent = 'Patterns';
        // The AI tab only appears if the server has a generator
        // (provided by @intijs/genui); the core ships none.
        const aiTab = document.createElement('button');
        aiTab.textContent = '✨ AI';
        aiTab.hidden = true;
        tabs.append(blocksTab, patternsTab, aiTab);

        const body = document.createElement('div');
        body.className = 'inti-composer-body';

        const showBlocks = () => {
            blocksTab.classList.add('active');
            patternsTab.classList.remove('active');
            body.innerHTML = '';
            const types = this.availableTypes();

            if (types.length === 0) {
                body.innerHTML = '<p class="inti-composer-empty">No block types. Declare them in &lt;InlineEditor blockTypes={[...]} /&gt; or add blocks from the CMS.</p>';
                return;
            }

            for (const type of types) {
                const item = document.createElement('button');
                item.className = 'inti-composer-item';
                item.innerHTML = `<strong>${type.label}</strong><span>${type.nativeType}</span>`;
                item.addEventListener('click', () => {
                    this.closeOverlay();
                    void this.insert(wrapper, type);
                });
                body.appendChild(item);
            }
        };

        const showPatterns = async () => {
            patternsTab.classList.add('active');
            blocksTab.classList.remove('active');
            body.innerHTML = '<p class="inti-composer-empty">Loading…</p>';

            const patterns = await this.loadPatterns();
            body.innerHTML = '';

            if (patterns.length === 0) {
                body.innerHTML = '<p class="inti-composer-empty">No saved patterns. Use ☆ on a block to save the current page as a pattern.</p>';
                return;
            }

            if (this.patternsAreShared) {
                const badge = document.createElement('p');
                badge.className = 'inti-composer-empty';
                badge.textContent = 'Patterns shared with the team';
                body.appendChild(badge);
            }

            for (const pattern of patterns) {
                const row = document.createElement('div');
                row.className = 'inti-composer-pattern';

                const item = document.createElement('button');
                item.className = 'inti-composer-item';
                item.innerHTML = `<strong>${pattern.name}</strong><span>${pattern.blocks.length} block(s)</span>`;
                item.addEventListener('click', () => {
                    this.closeOverlay();
                    void this.insertPattern(wrapper, pattern);
                });

                const del = document.createElement('button');
                del.className = 'inti-composer-pattern-del';
                del.textContent = '✕';
                del.title = 'Delete pattern';
                del.addEventListener('click', async () => {
                    try {
                        await this.deletePattern(pattern.name);
                    } catch (error) {
                        this.toast(`Could not delete: ${error instanceof Error ? error.message : error}`, 'error');
                    }
                    void showPatterns();
                });

                row.append(item, del);
                body.appendChild(row);
            }
        };

        const showAi = () => {
            aiTab.classList.add('active');
            blocksTab.classList.remove('active');
            patternsTab.classList.remove('active');
            body.innerHTML = '';
            this.renderAiPanel(wrapper, body);
        };

        blocksTab.addEventListener('click', showBlocks);
        patternsTab.addEventListener('click', showPatterns);
        aiTab.addEventListener('click', showAi);

        panel.append(tabs, body);
        showBlocks();

        // Discovered in the background so it does not delay the palette
        void this.aiAvailable().then((available) => {
            aiTab.hidden = !available;
        });
    }

    // ============================================
    // Settings panel (inferred form + variants)
    // ============================================

    private blockData(wrapper: HTMLElement): Record<string, any> | null {
        const script = wrapper.querySelector<HTMLScriptElement>('script[data-inti-block-json]');
        if (!script?.textContent) return null;
        try {
            return JSON.parse(script.textContent);
        } catch {
            return null;
        }
    }

    private openSettings(wrapper: HTMLElement): void {
        this.closeOverlay();

        const ctx = this.ctx(wrapper);
        const data = this.blockData(wrapper);

        if (!ctx || !data) {
            this.toast('This block does not expose its data (is BlockRenderer editable?)', 'error');
            return;
        }

        const nativeType = wrapper.dataset.intiBlockLabel || '';
        const variants = this.typeMeta(nativeType)?.variants || {};
        const panel = this.panelShell(`Settings — ${wrapper.dataset.intiBlock || nativeType}`);
        const form = document.createElement('form');
        form.className = 'inti-composer-body';

        const inputs = new Map<string, () => any>();

        for (const [key, value] of Object.entries(data)) {
            const field = document.createElement('label');
            field.className = 'inti-composer-field';
            field.innerHTML = `<span>${key}</span>`;

            if (variants[key]) {
                // Dev-declared variant → controlled select
                const select = document.createElement('select');
                for (const option of variants[key]) {
                    const opt = document.createElement('option');
                    opt.value = option;
                    opt.textContent = option;
                    if (option === value) opt.selected = true;
                    select.appendChild(opt);
                }
                field.appendChild(select);
                inputs.set(key, () => select.value);
            } else if (typeof value === 'boolean') {
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = value;
                field.appendChild(input);
                inputs.set(key, () => input.checked);
            } else if (typeof value === 'number') {
                const input = document.createElement('input');
                input.type = 'number';
                input.value = String(value);
                field.appendChild(input);
                inputs.set(key, () => Number(input.value));
            } else if (typeof value === 'string') {
                const long = value.length > 80 || value.includes('\n');
                const input = document.createElement(long ? 'textarea' : 'input');
                input.value = value;
                field.appendChild(input);
                inputs.set(key, () => input.value);
            } else {
                // Objects/arrays: editable JSON (advanced mode)
                const input = document.createElement('textarea');
                input.value = JSON.stringify(value, null, 2);
                input.className = 'inti-composer-json';
                field.appendChild(input);
                inputs.set(key, () => {
                    try { return JSON.parse(input.value); } catch { return value; }
                });
            }

            form.appendChild(field);
        }

        const save = document.createElement('button');
        save.type = 'submit';
        save.className = 'inti-composer-save';
        save.textContent = 'Save';
        form.appendChild(save);

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const patched: Record<string, any> = {};
            for (const [key, read] of inputs) patched[key] = read();

            void (async () => {
                try {
                    await this.post('updateBlock', {
                        documentId: ctx.documentId,
                        blockIndex: ctx.index,
                        data: patched
                    });
                    this.closeOverlay();
                    this.toast('Settings saved ✓ — reloading…', 'success');
                    setTimeout(() => window.location.reload(), 700);
                } catch (error) {
                    this.toast(`Could not save: ${error instanceof Error ? error.message : error}`, 'error');
                }
            })();
        });

        panel.appendChild(form);
    }

    // ============================================
    // Assisted composition
    // ============================================

    /** Does the server have a generator? It is asked only once */
    private async aiAvailable(): Promise<boolean> {
        if (this.aiIsAvailable !== undefined) return this.aiIsAvailable;

        try {
            // Empty prompt: probes the capability without spending a model call
            const result = await this.post('generateBlocks', { prompt: ' ', blockTypes: [] });
            this.aiIsAvailable = result?.available === true;
        } catch {
            this.aiIsAvailable = false;
        }

        return this.aiIsAvailable;
    }

    /** Instruction panel → proposal → insert */
    private renderAiPanel(wrapper: HTMLElement, body: HTMLElement): void {
        const intro = document.createElement('p');
        intro.className = 'inti-composer-empty';
        intro.textContent = 'Describe the section you need. It will be composed from your blocks, without inventing any.';

        const input = document.createElement('textarea');
        input.className = 'inti-composer-ai-input';
        input.rows = 3;
        input.placeholder = 'E.g.: a pricing section with three plans and a clear headline';

        const run = document.createElement('button');
        run.className = 'inti-composer-item';
        run.textContent = 'Generate proposal';

        const output = document.createElement('div');

        const generate = () => {
            const prompt = input.value.trim();
            if (!prompt) return;
            this.closeOverlay();
            void this.proposeBlocks(wrapper, prompt);
        };

        run.addEventListener('click', generate);
        body.append(intro, input, run);
        input.focus();
    }

    /**
     * Shows the proposal on the page, with the real components and block by block.
     * Nothing reaches the CMS until the editor accepts it.
     */
    private async proposeBlocks(wrapper: HTMLElement, prompt: string): Promise<void> {
        const region = document.createElement('section');
        region.setAttribute('data-inti-proposal', '');
        region.style.cssText = 'outline: 2px dashed #7c3aed; outline-offset: 4px; margin: 1rem 0;';

        const bar = document.createElement('div');
        bar.style.cssText =
            'position: sticky; top: 0.5rem; z-index: 99998; display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem 0.75rem; background: #7c3aed; color: white; border-radius: 0.375rem; font: 13px system-ui, sans-serif;';
        const status = document.createElement('span');
        status.textContent = 'Generating proposal…';
        bar.appendChild(status);

        const previews = document.createElement('div');
        region.append(bar, previews);
        wrapper.after(region);

        const blocks: SavedPattern['blocks'] = [];
        const warnings: string[] = [];

        const action = (text: string, onClick: () => void) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.style.cssText =
                'background: rgba(255,255,255,0.2); color: inherit; border: 0; border-radius: 0.25rem; padding: 0.25rem 0.5rem; font: inherit; cursor: pointer;';
            button.addEventListener('click', onClick);
            bar.appendChild(button);
        };

        action('Discard', () => region.remove());

        try {
            const response = await fetch(this.generatePath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    blockTypes: this.blockTypes.map((type) => ({
                        nativeType: type.nativeType,
                        label: type.label,
                        description: type.description,
                        when: type.when,
                        fields: type.fields,
                        variants: type.variants
                    }))
                })
            });

            if (!response.ok || !response.body) {
                const text = await response.text().catch(() => '');
                throw new Error(`${response.status} ${text.slice(0, 150)}`);
            }

            const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
            let pending = '';

            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;

                pending += value;
                const lines = pending.split('\n');
                pending = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    const event = JSON.parse(line);

                    if (event.type === 'block') {
                        blocks.push(event.block);
                        status.textContent = `Generating proposal… ${blocks.length} block(s)`;
                        previews.insertAdjacentHTML('beforeend', await this.renderPreview(event.rendered));
                    } else if (event.type === 'warning') {
                        warnings.push(event.message);
                    } else if (event.type === 'error') {
                        throw new Error(event.message);
                    }
                }
            }

            if (blocks.length === 0) {
                status.textContent = 'No block was proposed. Try describing it another way.';
                return;
            }

            status.textContent = `Proposal of ${blocks.length} block(s). Nothing has been saved yet.`;
            status.title = warnings.join('\n');
            action('Accept and insert', () => void this.insertPattern(wrapper, { name: 'AI proposal', blocks }));
        } catch (error) {
            status.textContent = `Could not generate: ${error instanceof Error ? error.message : error}`;
        }
    }

    /** HTML of a block with its real component, without saving it */
    private async renderPreview(block: SavedPattern['blocks'][number]): Promise<string> {
        const response = await fetch(this.previewPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blocks: [block] })
        });
        return response.ok ? response.text() : '';
    }

    // ============================================
    // Patterns
    // ============================================
    //
    // With a pattern store registered (@intijs/core/team), the server
    // returns a store shared by the team. Without it, each editor keeps
    // their own in their own localStorage.

    private loadLocalPatterns(): SavedPattern[] {
        try {
            return JSON.parse(localStorage.getItem(PATTERNS_KEY) || '[]');
        } catch {
            return [];
        }
    }

    private saveLocalPatterns(patterns: SavedPattern[]): void {
        localStorage.setItem(PATTERNS_KEY, JSON.stringify(patterns));
    }

    /** Reads the team's patterns; falls back to the local ones if there is no store */
    private async loadPatterns(): Promise<SavedPattern[]> {
        try {
            const result = await this.post('listPatterns', {});
            if (result?.shared) {
                this.patternsAreShared = true;
                return result.patterns ?? [];
            }
        } catch {
            // Server without the action or without a store: the local store is used
        }

        this.patternsAreShared = false;
        return this.loadLocalPatterns();
    }

    /** Saves a pattern where it belongs, depending on whether there is a shared store */
    private async persistPattern(pattern: SavedPattern): Promise<void> {
        try {
            const result = await this.post('savePattern', pattern);
            if (result?.shared) {
                this.patternsAreShared = true;
                return;
            }
        } catch (error) {
            // If the server rejects it (expired license, permissions), no local
            // copy is saved behind the editor's back: the editor must find out.
            if (this.patternsAreShared) throw error;
        }

        const patterns = this.loadLocalPatterns().filter(p => p.name !== pattern.name);
        patterns.push(pattern);
        this.saveLocalPatterns(patterns);
    }

    /** Deletes a pattern from the store it belongs to */
    private async deletePattern(name: string): Promise<void> {
        try {
            const result = await this.post('deletePattern', { name });
            if (result?.shared) return;
        } catch (error) {
            if (this.patternsAreShared) throw error;
        }

        this.saveLocalPatterns(this.loadLocalPatterns().filter(p => p.name !== name));
    }

    /** Saves all blocks of the wrapper's document as a pattern */
    private async savePagePattern(wrapper: HTMLElement): Promise<void> {
        const documentId = wrapper.dataset.intiDocumentId;
        if (!documentId) return;

        const blocks: SavedPattern['blocks'] = [];
        document
            .querySelectorAll<HTMLElement>(`[data-inti-block][data-inti-document-id="${documentId}"]`)
            .forEach(w => {
                const native = w.dataset.intiBlockLabel;
                const data = this.blockData(w);
                if (native && !native.startsWith('gutenberg:') && data) {
                    blocks.push({ nativeType: native, data });
                }
            });

        if (blocks.length === 0) {
            this.toast('There are no serializable blocks to save', 'error');
            return;
        }

        const name = prompt(`Pattern name (${blocks.length} blocks):`);
        if (!name) return;

        try {
            await this.persistPattern({ name, blocks });
            this.toast(
                this.patternsAreShared
                    ? `Pattern "${name}" saved for the team ✓`
                    : `Pattern "${name}" saved ✓`,
                'success'
            );
        } catch (error) {
            this.toast(`Could not save: ${error instanceof Error ? error.message : error}`, 'error');
        }
    }

    /**
     * Inserts the pattern's blocks after the wrapper, as a unit.
     *
     * A single call, not N: the server makes sure the pattern goes in
     * whole or not at all. This used to be a loop of requests, and a
     * failure halfway left the page with half a pattern published.
     */
    private async insertPattern(wrapper: HTMLElement, pattern: SavedPattern): Promise<void> {
        const ctx = this.ctx(wrapper);
        if (!ctx) return;

        try {
            await this.post('insertBlocks', {
                documentId: ctx.documentId,
                index: ctx.index + 1,
                blocks: pattern.blocks.map((block) => ({
                    nativeType: block.nativeType,
                    data: block.data
                }))
            });
            this.toast(`Pattern "${pattern.name}" inserted ✓ — reloading…`, 'success');
            setTimeout(() => window.location.reload(), 700);
        } catch (error) {
            this.toast(
                `The pattern was not inserted: ${error instanceof Error ? error.message : error}`,
                'error'
            );
            setTimeout(() => window.location.reload(), 1500);
        }
    }

    // ============================================
    // Shared UI
    // ============================================

    /** Side drawer with a title and a close button */
    private panelShell(title: string): HTMLElement {
        const overlay = document.createElement('div');
        overlay.className = 'inti-composer-overlay';
        overlay.addEventListener('mousedown', (event) => {
            if (event.target === overlay) this.closeOverlay();
        });

        const panel = document.createElement('div');
        panel.className = 'inti-composer-panel';

        const header = document.createElement('div');
        header.className = 'inti-composer-header';
        header.innerHTML = `<strong>${title}</strong>`;

        const close = document.createElement('button');
        close.textContent = '✕';
        close.addEventListener('click', () => this.closeOverlay());
        header.appendChild(close);

        panel.appendChild(header);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        this.overlay = overlay;

        return panel;
    }

    private closeOverlay(): void {
        this.overlay?.remove();
        this.overlay = null;
    }

    private renumber(documentId: string): void {
        document
            .querySelectorAll<HTMLElement>(`[data-inti-block][data-inti-document-id="${documentId}"]`)
            .forEach((wrapper, i) => {
                wrapper.dataset.intiBlockIndex = String(i);
            });
    }

    private toast(message: string, type: 'success' | 'error'): void {
        document.querySelector('.inti-inline-toast')?.remove();

        const toast = document.createElement('div');
        toast.className = 'inti-inline-toast';
        toast.textContent = message;
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

    private injectStyles(): void {
        if (document.getElementById('inti-composer-styles')) return;

        const style = document.createElement('style');
        style.id = 'inti-composer-styles';
        style.textContent = `
            .inti-composer-bar {
                position: absolute;
                top: 0.4rem;
                right: 0.4rem;
                display: none;
                gap: 0.2rem;
                background: rgba(30, 41, 59, 0.9);
                border-radius: 0.4rem;
                padding: 0.2rem;
                z-index: 99999;
            }
            [data-inti-block]:hover > .inti-composer-bar { display: flex; }
            .inti-composer-bar button {
                width: 1.7rem;
                height: 1.7rem;
                border: none;
                background: transparent;
                color: #e2e8f0;
                border-radius: 0.3rem;
                cursor: pointer;
                font-size: 0.85rem;
                line-height: 1;
            }
            .inti-composer-bar button:hover { background: #334155; }

            .inti-composer-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.35);
                z-index: 9999998;
                display: flex;
                justify-content: flex-end;
            }
            .inti-composer-panel {
                width: min(380px, 92vw);
                height: 100%;
                background: #0f172a;
                color: #e2e8f0;
                font-family: system-ui, sans-serif;
                font-size: 0.875rem;
                display: flex;
                flex-direction: column;
                box-shadow: -8px 0 24px rgba(0,0,0,0.4);
            }
            .inti-composer-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 0.9rem 1rem;
                border-bottom: 1px solid #1e293b;
            }
            .inti-composer-header button {
                border: none; background: transparent; color: #94a3b8; cursor: pointer; font-size: 1rem;
            }
            .inti-composer-tabs { display: flex; border-bottom: 1px solid #1e293b; }
            .inti-composer-tabs button {
                flex: 1; padding: 0.6rem; border: none; background: transparent;
                color: #94a3b8; cursor: pointer; border-bottom: 2px solid transparent;
            }
            .inti-composer-tabs button.active { color: #e2e8f0; border-bottom-color: #3b82f6; }
            .inti-composer-body { padding: 0.8rem; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 0.5rem; }
            .inti-composer-empty { color: #94a3b8; line-height: 1.5; }
            .inti-composer-item {
                display: flex; flex-direction: column; gap: 0.15rem; text-align: left;
                padding: 0.6rem 0.75rem; border: 1px solid #1e293b; border-radius: 0.45rem;
                background: #1e293b; color: inherit; cursor: pointer; width: 100%;
            }
            .inti-composer-item:hover { border-color: #3b82f6; }
            .inti-composer-item span { color: #94a3b8; font-size: 0.75rem; }
            .inti-composer-ai-input {
                width: 100%; box-sizing: border-box; margin-bottom: 0.5rem;
                padding: 0.5rem; border-radius: 0.35rem; border: 1px solid #d1d5db;
                font: 400 0.8rem/1.4 system-ui, sans-serif; resize: vertical;
            }
            .inti-composer-pattern { display: flex; gap: 0.4rem; align-items: stretch; }
            .inti-composer-pattern-del {
                border: none; background: transparent; color: #94a3b8; cursor: pointer;
            }
            .inti-composer-field { display: flex; flex-direction: column; gap: 0.25rem; }
            .inti-composer-field > span { color: #94a3b8; font-size: 0.75rem; }
            .inti-composer-field input[type="text"],
            .inti-composer-field input[type="number"],
            .inti-composer-field input:not([type]),
            .inti-composer-field textarea,
            .inti-composer-field select {
                padding: 0.45rem 0.6rem; border: 1px solid #334155; border-radius: 0.35rem;
                background: #1e293b; color: #e2e8f0; outline: none; font: inherit;
            }
            .inti-composer-field textarea { min-height: 4.5rem; resize: vertical; }
            .inti-composer-json { font-family: ui-monospace, monospace; font-size: 0.78rem; }
            .inti-composer-save {
                margin-top: 0.5rem; padding: 0.55rem; border: none; border-radius: 0.4rem;
                background: #2563eb; color: white; cursor: pointer; font-weight: 600;
            }
            .inti-composer-save:hover { background: #1d4ed8; }
        `;
        document.head.appendChild(style);
    }
}

let globalComposer: BlockComposer | null = null;

/** Initializes (or returns) the global composer */
export function initBlockComposer(config?: BlockComposerConfig): BlockComposer {
    if (!globalComposer) {
        globalComposer = new BlockComposer(config).init();
    }
    return globalComposer;
}
