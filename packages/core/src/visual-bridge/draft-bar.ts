/**
 * The editor's draft bar.
 *
 * On published content it offers to open a working copy; on a draft, to
 * publish or discard it. Editing the copy needs nothing else: its blocks
 * already carry the copy's `documentId`, so the editor writes there.
 */

const DRAFT_PARAM = 'inti-draft';

export interface DraftBarConfig {
    actionBase?: string;
}

function currentDocumentId(): string | undefined {
    return document.querySelector<HTMLElement>('[data-inti-block][data-inti-document-id]')?.dataset.intiDocumentId;
}

export function initDraftBar(config: DraftBarConfig = {}): void {
    if (document.querySelector('[data-inti-draft-bar]')) return;

    const documentId = currentDocumentId();
    if (!documentId) return;

    const actionBase = config.actionBase || '/_actions/inti.';
    const url = new URL(window.location.href);
    const inDraft = url.searchParams.has(DRAFT_PARAM);

    const bar = document.createElement('div');
    bar.setAttribute('data-inti-draft-bar', inDraft ? 'draft' : 'published');
    bar.style.cssText = [
        'position: fixed',
        'bottom: 1.5rem',
        'right: 1.5rem',
        'display: flex',
        'gap: 0.5rem',
        'align-items: center',
        'padding: 0.5rem 0.75rem',
        `background: ${inDraft ? '#92400e' : '#1f2937'}`,
        'color: white',
        'border-radius: 0.5rem',
        'font: 13px system-ui, sans-serif',
        'box-shadow: 0 4px 12px rgba(0,0,0,0.25)',
        'z-index: 9999998'
    ].join(';');

    const label = document.createElement('span');
    label.textContent = inDraft ? 'Draft: visitors do not see these changes' : 'Published: what you edit shows when saved';
    bar.appendChild(label);

    const act = async (action: string, then: (result: any) => void) => {
        bar.querySelectorAll('button').forEach((button) => (button.disabled = true));
        try {
            const response = await fetch(`${actionBase}${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentId })
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`${response.status} ${body.slice(0, 150)}`);
            }
            then(await response.json().catch(() => null));
        } catch (error) {
            label.textContent = `Could not complete: ${error instanceof Error ? error.message : error}`;
            bar.querySelectorAll('button').forEach((button) => (button.disabled = false));
        }
    };

    const goTo = (draft: boolean) => {
        const target = new URL(window.location.href);
        if (draft) target.searchParams.set(DRAFT_PARAM, '1');
        else target.searchParams.delete(DRAFT_PARAM);
        window.location.assign(target.href);
    };

    const button = (text: string, onClick: () => void) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = text;
        element.style.cssText =
            'background: rgba(255,255,255,0.15); color: inherit; border: 0; border-radius: 0.25rem; padding: 0.25rem 0.5rem; font: inherit; cursor: pointer;';
        element.addEventListener('click', onClick);
        bar.appendChild(element);
    };

    if (inDraft) {
        button('Publish', () => {
            void act('publishDraft', () => goTo(false));
        });
        button('Discard', () => {
            if (window.confirm('Discard this draft? The published version does not change.')) {
                void act('discardDraft', () => goTo(false));
            }
        });
    } else {
        button('Edit as draft', () => {
            void act('createDraft', () => goTo(true));
        });
    }

    document.body.appendChild(bar);
}
