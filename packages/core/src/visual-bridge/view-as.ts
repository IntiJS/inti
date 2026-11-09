/**
 * "View as": the page as a specific visitor would receive it.
 *
 * Without this, each variant is checked blindly. What you see can be edited with a
 * double click as always: each block keeps its address in the CMS.
 */

const VIEW_AS_PARAM = 'inti-as';

export function initViewAs(): void {
    if (!document.querySelector('[data-inti-adaptive]') || document.querySelector('[data-inti-view-as]')) return;

    const url = new URL(window.location.href);

    const form = document.createElement('form');
    form.setAttribute('data-inti-view-as', '');
    form.style.cssText = [
        'position: fixed',
        'bottom: 5rem',
        'right: 1.5rem',
        'display: flex',
        'gap: 0.5rem',
        'padding: 0.5rem 0.75rem',
        'background: #1f2937',
        'color: white',
        'border-radius: 0.5rem',
        'font: 13px system-ui, sans-serif',
        'box-shadow: 0 4px 12px rgba(0,0,0,0.25)',
        'z-index: 9999998'
    ].join(';');

    const label = document.createElement('label');
    label.textContent = 'View as ';

    const input = document.createElement('input');
    input.value = url.searchParams.get(VIEW_AS_PARAM) ?? '';
    input.placeholder = 'device:mobile;pref.diet:vegan';
    input.style.cssText = 'width: 16rem; font: inherit; color: #111; border-radius: 0.25rem; border: 0; padding: 0.125rem 0.375rem;';
    label.appendChild(input);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = input.value ? 'Apply (empty: all)' : 'Apply';
    submit.style.cssText = 'background: rgba(255,255,255,0.15); color: inherit; border: 0; border-radius: 0.25rem; padding: 0.125rem 0.5rem; font: inherit; cursor: pointer;';

    form.append(label, submit);
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (value) url.searchParams.set(VIEW_AS_PARAM, value);
        else url.searchParams.delete(VIEW_AS_PARAM);
        window.location.assign(url.href);
    });

    document.body.appendChild(form);
}
