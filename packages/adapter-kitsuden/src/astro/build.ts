/**
 * Build-time pieces of a Kitsuden site.
 */

/**
 * Secrets a Kitsuden site reads at runtime and must never end up in the build output. Vite
 * inlines `import.meta.env` values it can see at build time; removing them from the build's
 * environment makes that impossible, whatever a component does.
 */
export const KITSUDEN_SECRETS = [
    'INTI_KITSUDEN_TOKEN',
    'INTI_TOKEN',
    'KITSUDEN_SITE_KEY',
    // Kitsuden builds with Spanish names
    'SITIO_API_CLAVE',
    'KITSUDEN_PURGE_SECRET'
] as const;

/**
 * Call at the top of `astro.config.mjs`. During `astro build` it removes the secrets from
 * `process.env`; in `astro dev` and at runtime it does nothing.
 */
export function stripSecretsForBuild(extra: string[] = [], argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string[] {
    if (!argv.includes('build')) return [];
    const removed: string[] = [];
    for (const name of [...KITSUDEN_SECRETS, ...extra]) {
        if (name in env) {
            delete env[name];
            removed.push(name);
        }
    }
    return removed;
}

/**
 * An Astro integration that mounts Inti's actions at `/_actions/*` without a
 * `src/actions/index.ts`, pointing them at your own entry. Useful when Inti is optional (an
 * `INTI=true` switch): with the file present Astro would mount the actions, and import Inti,
 * in every build.
 */
export function kitsudenActions(options: { enabled?: boolean } = {}) {
    return {
        name: '@intijs/adapter-kitsuden/actions',
        hooks: {
            'astro:config:setup': ({ injectRoute }: { injectRoute: (route: { pattern: string; entrypoint: string; prerender?: boolean }) => void }) => {
                if (options.enabled === false) return;
                injectRoute({ pattern: '/_actions/[...path]', entrypoint: 'astro/actions/runtime/entrypoints/route.js', prerender: false });
            }
        }
    };
}
