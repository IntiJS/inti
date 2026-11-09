import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AstroIntegration } from 'astro';
import unocss from '@unocss/astro';

/** How Tailwind was detected in the project */
export interface TailwindDetection {
    /** Installed major, if it can be known */
    major: number | null;
    /** What gave it away: a configuration file or a dependency */
    via: string;
}

const CONFIG_FILES = ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.mjs', 'tailwind.config.cjs'];

/** Packages that are only installed to use Tailwind */
const TAILWIND_PACKAGES = ['tailwindcss', '@tailwindcss/vite', '@astrojs/tailwind', '@tailwindcss/postcss'];

/** Major of a package.json range: '^4.1.0' → 4, 'latest' → null */
function majorOf(range: unknown): number | null {
    if (typeof range !== 'string') return null;
    const match = range.match(/(\d+)/);
    return match ? Number(match[1]) : null;
}

/**
 * Does the project use Tailwind?
 *
 * It checks the configuration file AND the dependencies. It used to check
 * only the file, but Tailwind 4 —the current version— is configured from CSS
 * and has none: with v4, Inti enabled UnoCSS on top of Tailwind and the
 * classes collided.
 */
export function detectTailwind(cwd: string): TailwindDetection | null {
    let deps: Record<string, unknown> = {};
    try {
        const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
        deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
        // Without a readable package.json the decision rests on the file alone
    }

    const major = majorOf(deps.tailwindcss);

    const config = CONFIG_FILES.find((file) => existsSync(resolve(cwd, file)));
    if (config) return { major, via: config };

    const pkg = TAILWIND_PACKAGES.find((name) => name in deps);
    if (pkg) {
        // @tailwindcss/vite and @tailwindcss/postcss only exist since v4
        const inferred = major ?? (pkg.startsWith('@tailwindcss/') ? 4 : null);
        return { major: inferred, via: pkg };
    }

    return null;
}

/** How to include Inti's components in the class scan, by version */
function sourceHint(major: number | null): string {
    if (major !== null && major >= 4) {
        return 'Add to your main CSS: @source "../node_modules/@intijs/core";';
    }
    return 'Add to "content" in your tailwind.config: "./node_modules/@intijs/core/**/*.astro"';
}

/**
 * Inti's style engine.
 *
 * By default it enables UnoCSS with preset-wind, which understands the same
 * classes as Tailwind. If the project already uses Tailwind, it steps aside:
 * two engines generating the same classes collide.
 */
export function intiStyles(): AstroIntegration {
    const tailwind = detectTailwind(process.cwd());

    if (tailwind) {
        console.warn(
            `\n⚠️  [Inti.js] Tailwind detected (${tailwind.via}). ` +
                'Disabling the built-in UnoCSS engine to avoid collisions.'
        );
        console.info(`💡  [Inti.js] ${sourceHint(tailwind.major)}\n`);

        return {
            name: '@intijs/styles-bridge',
            hooks: {}
        };
    }

    console.info('\n⚡ [Inti.js] Enabling the Ultra-Fast Style Engine (UnoCSS)');

    return unocss({
        injectReset: true
    }) as unknown as AstroIntegration;
}
