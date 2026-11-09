import type { AstroComponentFactory } from 'astro/runtime/server/index.js';

type ComponentModule = {
    default: AstroComponentFactory | any;
};

type BlockRegistration = {
    /** Function that returns the component (lazy load) */
    component: (() => Promise<ComponentModule>) | any;
    /**
     * @deprecated It has no effect, and cannot have one.
     *
     * Astro only hydrates statically imported components: the compiler
     * needs the module path to generate the island. The registry loads
     * them with a dynamic `import()`, and applying `client:*` to such a
     * component fails with `NoMatchingImport` (verified on Astro 7).
     *
     * The directive goes inside the block, in a static import:
     *
     * ```astro
     * ---
     * // src/blocks/Carousel.astro
     * import Carousel from '../components/Carousel.svelte';
     * ---
     * <Carousel client:visible {...Astro.props} />
     * ```
     *
     * The `.astro` block itself can arrive through a dynamic import: the
     * compiler generates the island when it processes the block.
     * `BlockRenderer` warns in development if it finds this option.
     */
    clientDirective?: 'load' | 'idle' | 'visible' | 'media' | 'only';
    /** Framework used (svelte, react, vue, astro) */
    framework?: 'astro' | 'react' | 'vue' | 'svelte' | 'solid';
    /** Metadata for discovery by AI and Visual Bridge */
    meta?: {
        label?: string;
        description?: string;
        category?: string;
        /** Sample data for mock generation */
        mockData?: Record<string, any>;
        /** Field definitions (optional, for validation) */
        schema?: Record<string, any>;
    };
};

/**
 * Component Registry - Hot-Swap Architecture
 * Maps CMS block names to actual components without manual imports
 */
export class ComponentRegistry {
    private registry = new Map<string, BlockRegistration>();

    register(blockType: string, registration: BlockRegistration) {
        this.registry.set(blockType, registration);
    }

    get(blockType: string): BlockRegistration | undefined {
        return this.registry.get(blockType);
    }

    has(blockType: string): boolean {
        return this.registry.has(blockType);
    }

    /**
     * Generates a manifest of all registered blocks.
     * Useful for the AI to understand what it can build.
     */
    getManifest() {
        const manifest: Record<string, any> = {};
        for (const [type, reg] of this.registry.entries()) {
            manifest[type] = {
                framework: reg.framework || 'astro',
                clientDirective: reg.clientDirective,
                ...reg.meta
            };
        }
        return manifest;
    }
}

const _global = globalThis as any;
if (!_global.__intiComponentRegistry) {
    _global.__intiComponentRegistry = new ComponentRegistry();
}

export const registry = _global.__intiComponentRegistry as ComponentRegistry;
export type { BlockRegistration, ComponentModule };

// ============================================
// Registration by convention
// ============================================

export interface RegisterBlocksOptions {
    /**
     * @deprecated No effect: see `BlockRegistration.clientDirective`. The
     * `client:*` directive goes inside each block, in a static import.
     */
    clientDirective?: BlockRegistration['clientDirective'];
    framework?: BlockRegistration['framework'];
    /**
     * Translates the file name into the block type. By default the name
     * without extension is used: `src/blocks/HeroBanner.astro` → 'HeroBanner'.
     */
    typeFromPath?: (path: string) => string;
}

/**
 * The Inti type of a native identifier, to render something that has not gone
 * through an adapter yet: `hero` if such a block exists (Kitsuden), otherwise
 * `hero_banner` → `HeroBanner` (WordPress) and `sections.hero` → `Hero` (Strapi).
 */
export function blockTypeForPreview(nativeType: string): string {
    if (registry.has(nativeType)) return nativeType;
    const last = nativeType.split('.').pop() ?? nativeType;
    return last
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

/** `/src/blocks/HeroBanner.astro` → `HeroBanner` */
export function blockTypeFromPath(path: string): string {
    const file = path.split('/').pop() ?? path;
    return file.replace(/\.[^.]+$/, '');
}

/**
 * Registers all the components of a folder in one go.
 *
 * Meant to receive the result of `import.meta.glob`, which Vite
 * resolves in the user's project:
 *
 * ```ts
 * import { registerBlocks } from '@intijs/core/registry';
 * registerBlocks(import.meta.glob('/src/blocks/*.astro'));
 * ```
 *
 * The file name is the block type, and the adapters already
 * normalize to PascalCase (`hero_banner` → `HeroBanner`), so
 * `src/blocks/HeroBanner.astro` renders ACF's `hero_banner` layout
 * with no extra configuration.
 *
 * @returns The registered block types
 */
export function registerBlocks(
    modules: Record<string, () => Promise<any>>,
    options: RegisterBlocksOptions = {}
): string[] {
    const toType = options.typeFromPath ?? blockTypeFromPath;
    const registered: string[] = [];

    for (const [path, loader] of Object.entries(modules)) {
        if (typeof loader !== 'function') continue;

        const blockType = toType(path);
        if (!blockType) continue;

        registry.register(blockType, {
            component: loader,
            clientDirective: options.clientDirective,
            framework: options.framework,
            meta: { label: blockType }
        });
        registered.push(blockType);
    }

    return registered;
}
