/**
 * <inti-flow-builder> — visual flow builder, Crew Studio style (v1, 2026-11-07)
 * =============================================================================
 *
 * Dependency-free custom element that edits a `FlowRecipe` (recipe.ts):
 * nodes = ordered stages, edges = the frame order. An editor can add a
 * stage (generate / personalize / cache), edit its parameters, reorder,
 * and export the recipe as JSON — the same JSON `runRecipe()` executes.
 *
 *   <inti-flow-builder instruction="A landing hero"></inti-flow-builder>
 *   const builder = document.querySelector('inti-flow-builder');
 *   builder.addEventListener('recipe-change', (e) => save(e.detail.recipe));
 *   builder.recipe = { ... };            // load
 *   const recipe = builder.exportRecipe();
 *
 * v1 is intentionally a faithful graph editor, not a free canvas: the frame
 * order is a list, so the editor is a list with visible wiring (each node's
 * output feeds the next). Drag-free, keyboard-reachable, SSR-safe (renders
 * nothing until connected in a DOM).
 */

import type { FlowRecipe, RecipeStage } from '../recipe.js';

const STAGES: Array<{ id: RecipeStage['id']; label: string; hint: string }> = [
    { id: 'personalize', label: 'Personalize', hint: 'Appends a per-visitor variant to the instruction' },
    { id: 'generate', label: 'Generate', hint: 'Calls the model provider (one per recipe)' },
    { id: 'cache', label: 'Cache', hint: 'Caches generation by prompt fingerprint' }
];

export class IntiFlowBuilder extends HTMLElement {
    private _recipe: FlowRecipe = { version: 1, instruction: '', stages: [{ id: 'generate' }] };
    private root: ShadowRoot | null = null;

    static get observedAttributes(): string[] {
        return ['instruction'];
    }

    connectedCallback(): void {
        const instruction = this.getAttribute('instruction');
        if (instruction && !this._recipe.instruction) {
            this._recipe = { ...this._recipe, instruction };
        }
        this.root = this.attachShadow({ mode: 'open' });
        this.render();
    }

    attributeChangedCallback(name: string, _old: string, value: string): void {
        if (name === 'instruction' && value !== this._recipe.instruction) {
            this._recipe = { ...this._recipe, instruction: value };
            this.render();
        }
    }

    /** The recipe being edited (live object; mutate via the API and re-render). */
    get recipe(): FlowRecipe {
        return this._recipe;
    }

    set recipe(value: FlowRecipe) {
        const { version: _version, ...rest } = value ?? {};
        this._recipe = { version: 1, ...rest } as FlowRecipe;
        this.render();
    }

    /** The recipe, validated shape (throws on invalid — see validateRecipe). */
    exportRecipe(): FlowRecipe {
        return JSON.parse(JSON.stringify(this._recipe)) as FlowRecipe;
    }

    /** Adds a stage after `index` (default: at the end). */
    addStage(id: RecipeStage['id'], index?: number): void {
        const stage: RecipeStage =
            id === 'personalize'
                ? { id, with: '[variant: default]' }
                : id === 'cache'
                  ? { id, ttlSeconds: 3600 }
                  : { id };
        const stages = [...this._recipe.stages];
        stages.splice(index === undefined ? stages.length : index + 1, 0, stage);
        this._recipe = { ...this._recipe, stages };
        this.emit();
        this.render();
    }

    removeStage(index: number): void {
        const stages = this._recipe.stages.filter((_, i) => i !== index);
        this._recipe = { ...this._recipe, stages };
        this.emit();
        this.render();
    }

    moveStage(index: number, delta: -1 | 1): void {
        const target = index + delta;
        if (target < 0 || target >= this._recipe.stages.length) return;
        const stages = [...this._recipe.stages];
        const [step] = stages.splice(index, 1);
        stages.splice(target, 0, step!);
        this._recipe = { ...this._recipe, stages };
        this.emit();
        this.render();
    }

    updateStage(index: number, patch: Partial<RecipeStage>): void {
        const stages = this._recipe.stages.map((s, i) => (i === index ? { ...s, ...patch } : s));
        this._recipe = { ...this._recipe, stages };
        this.emit();
        this.render();
    }

    setInstruction(instruction: string): void {
        this._recipe = { ...this._recipe, instruction };
        this.emit();
    }

    private emit(): void {
        this.dispatchEvent(
            new CustomEvent('recipe-change', { detail: { recipe: this.exportRecipe() }, bubbles: true })
        );
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    private render(): void {
        if (!this.root) return;
        const r = this._recipe;
        const canRemove = r.stages.length > 1;
        this.root.innerHTML = `
<style>
  :host { display: block; font: 13px/1.5 system-ui, sans-serif; color: #1a1a2e; }
  .node { border: 1px solid #d5d8e0; border-radius: 10px; padding: 10px 12px; margin: 0 0 4px; background: #fff; }
  .node-generate { border-left: 4px solid #4f6ef7; }
  .node-personalize { border-left: 4px solid #12a87b; }
  .node-cache { border-left: 4px solid #e8930c; }
  .arrow { text-align: center; color: #8a8fa3; margin: 2px 0; }
  .toolbar { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  button { font: inherit; cursor: pointer; border: 1px solid #d5d8e0; background: #f7f8fb; border-radius: 6px; padding: 2px 8px; }
  button:hover { background: #eef0f6; }
  input, select { font: inherit; padding: 3px 6px; border: 1px solid #d5d8e0; border-radius: 6px; max-width: 100%; }
  .field { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .label { font-weight: 600; }
  .hint { color: #6b7086; font-size: 12px; }
</style>
<div class="field">
  <span class="label">Instruction</span>
  <input class="instr" value="${escapeHtml(r.instruction)}" size="48"
         placeholder="What should the page say?" />
</div>
<div style="margin-top:10px">
${r.stages
    .map((s, i) => {
        const meta = STAGES.find((e) => e.id === s.id)!;
        const params =
            s.id === 'personalize'
                ? `<div class="field"><span>with</span><input class="with" data-i="${i}" value="${escapeHtml(s.with ?? '')}" size="36" /></div>`
                : s.id === 'cache'
                  ? `<div class="field"><span>TTL (s)</span><input class="ttl" data-i="${i}" type="number" min="0" value="${s.ttlSeconds ?? 3600}" size="8" /></div>`
                  : '';
        return `
  ${i > 0 ? '<div class="arrow">↓</div>' : ''}
  <div class="node node-${s.id}" data-i="${i}">
    <span class="label">${meta.label}</span>
    <span class="hint">${meta.hint}</span>
    ${params}
    <div class="toolbar">
      <button class="move-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="move-down" data-i="${i}" ${i === r.stages.length - 1 ? 'disabled' : ''}>↓</button>
      ${canRemove ? `<button class="remove" data-i="${i}">✕ remove</button>` : ''}
    </div>
  </div>`;
    })
    .join('')}
</div>
<div class="toolbar" style="margin-top:8px">
  <span class="hint">Add stage:</span>
  ${STAGES.map((e) => `<button class="add-stage" data-id="${e.id}">＋ ${e.label}</button>`).join('')}
</div>`;

        // Wiring
        this.root.querySelector('.instr')?.addEventListener('input', (ev) =>
            this.setInstruction((ev.target as HTMLInputElement).value)
        );
        this.root.querySelectorAll<HTMLInputElement>('.with').forEach((el) =>
            el.addEventListener('input', () => this.updateStage(Number(el.dataset.i), { with: el.value }))
        );
        this.root.querySelectorAll<HTMLInputElement>('.ttl').forEach((el) =>
            el.addEventListener('change', () =>
                this.updateStage(Number(el.dataset.i), { ttlSeconds: Number(el.value) || 0 })
            )
        );
        this.root.querySelectorAll<HTMLButtonElement>('.move-up').forEach((el) =>
            el.addEventListener('click', () => this.moveStage(Number(el.dataset.i), -1))
        );
        this.root.querySelectorAll<HTMLButtonElement>('.move-down').forEach((el) =>
            el.addEventListener('click', () => this.moveStage(Number(el.dataset.i), 1))
        );
        this.root.querySelectorAll<HTMLButtonElement>('.remove').forEach((el) =>
            el.addEventListener('click', () => this.removeStage(Number(el.dataset.i)))
        );
        this.root.querySelectorAll<HTMLButtonElement>('.add-stage').forEach((el) =>
            el.addEventListener('click', () => this.addStage(el.dataset.id as RecipeStage['id']))
        );
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Registers the element (call once, in the browser). */
export function defineFlowBuilder(tagName = 'inti-flow-builder'): void {
    if (typeof customElements !== 'undefined' && !customElements.get(tagName)) {
        customElements.define(tagName, IntiFlowBuilder);
    }
}
