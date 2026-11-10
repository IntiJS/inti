/**
 * Escapes text for use inside HTML that is built as a string.
 *
 * The titles, labels and names the editor shows come from the CMS, from the
 * block vocabulary or from what another editor typed (a pattern's name). None
 * of them is markup: a title such as `<img onerror=…>` must be shown, not run.
 * Prefer `textContent`; use this where a template is clearer.
 */
export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
