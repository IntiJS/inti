/**
 * SEO warnings on the blocks themselves, while they are edited.
 *
 * That is the difference from a side panel in the CMS admin: the warning
 * appears on top of the block that causes it, on the real page, next to
 * the field to fix. An editor who sees "alt is missing" floating over the
 * image fixes it; one who sees it in a separate list does not.
 *
 * It reuses the same auditor that runs in the build, so the editor sees
 * exactly what the crawler will see.
 */

import { auditBlock } from '../seo/audit.js';
import type { AuditFinding, AuditOptions } from '../seo/audit.js';

export interface SeoOverlayConfig {
    /** Rules to ignore */
    ignore?: string[];
    /** Minimum level to show (default: 'warning') */
    minLevel?: 'error' | 'warning' | 'info';
}

const LEVEL_ORDER = { info: 0, warning: 1, error: 2 } as const;

export class SeoOverlay {
    private config: SeoOverlayConfig;
    private badges: HTMLElement[] = [];

    constructor(config: SeoOverlayConfig = {}) {
        this.config = config;
    }

    init(): this {
        this.injectStyles();
        this.scan();
        return this;
    }

    rescan(): void {
        this.clear();
        this.scan();
    }

    private clear(): void {
        for (const badge of this.badges) badge.remove();
        this.badges = [];
    }

    /** Reads the JSON that BlockRenderer already emits and audits each block */
    private scan(): void {
        const minLevel = LEVEL_ORDER[this.config.minLevel ?? 'warning'];
        const options: AuditOptions = { ignore: this.config.ignore };

        document.querySelectorAll<HTMLElement>('[data-inti-block]').forEach((wrapper) => {
            const json = wrapper.querySelector('script[data-inti-block-json]');
            if (!json?.textContent) return;

            let data: Record<string, unknown>;
            try {
                data = JSON.parse(json.textContent);
            } catch {
                return;
            }

            const index = Number(wrapper.dataset.intiBlockIndex ?? 0);
            const type = wrapper.dataset.intiBlock ?? 'unknown';

            const findings = auditBlock({ type, data }, index, options).filter(
                (f) => LEVEL_ORDER[f.level] >= minLevel
            );

            if (findings.length > 0) this.attach(wrapper, findings);
        });
    }

    private attach(wrapper: HTMLElement, findings: AuditFinding[]): void {
        // The badge is positioned relative to the block
        if (getComputedStyle(wrapper).position === 'static') {
            wrapper.style.position = 'relative';
        }

        const worst = findings.some((f) => f.level === 'error') ? 'error' : 'warning';

        const badge = document.createElement('div');
        badge.className = `inti-seo-badge inti-seo-${worst}`;
        badge.textContent = `SEO ${findings.length}`;
        badge.setAttribute('role', 'button');
        badge.setAttribute('tabindex', '0');
        badge.setAttribute(
            'aria-label',
            `${findings.length} SEO finding(s) in this block. Activate to see the details.`
        );

        const panel = document.createElement('div');
        panel.className = 'inti-seo-panel';
        panel.hidden = true;

        for (const finding of findings) {
            const row = document.createElement('p');
            row.className = 'inti-seo-row';
            row.textContent = finding.field ? `${finding.field} — ${finding.message}` : finding.message;
            panel.appendChild(row);
        }

        const toggle = () => {
            panel.hidden = !panel.hidden;
        };
        badge.addEventListener('click', toggle);
        badge.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });

        badge.appendChild(panel);
        wrapper.appendChild(badge);
        this.badges.push(badge);
    }

    private injectStyles(): void {
        if (document.getElementById('inti-seo-overlay-styles')) return;

        const style = document.createElement('style');
        style.id = 'inti-seo-overlay-styles';
        style.textContent = `
            .inti-seo-badge {
                position: absolute; top: 0.5rem; right: 0.5rem; z-index: 999990;
                font: 500 0.7rem/1 system-ui, sans-serif; letter-spacing: 0.03em;
                padding: 0.3rem 0.5rem; border-radius: 0.35rem; cursor: pointer;
                color: #fff; user-select: none;
            }
            .inti-seo-warning { background: #b45309; }
            .inti-seo-error { background: #b91c1c; }
            .inti-seo-badge:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
            .inti-seo-panel {
                position: absolute; top: calc(100% + 0.35rem); right: 0; width: 17rem;
                background: #111827; color: #e5e7eb; border-radius: 0.4rem;
                padding: 0.5rem 0.6rem; cursor: auto;
                box-shadow: 0 6px 18px rgba(0,0,0,0.3);
            }
            .inti-seo-row {
                margin: 0 0 0.35rem; font: 400 0.72rem/1.35 system-ui, sans-serif;
            }
            .inti-seo-row:last-child { margin-bottom: 0; }
        `;
        document.head.appendChild(style);
    }
}

let instance: SeoOverlay | null = null;

export function initSeoOverlay(config: SeoOverlayConfig = {}): SeoOverlay {
    if (!instance) instance = new SeoOverlay(config).init();
    return instance;
}
