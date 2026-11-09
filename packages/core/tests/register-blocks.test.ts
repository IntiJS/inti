import { describe, test, expect, beforeEach } from 'bun:test';
import { registry, registerBlocks, blockTypeFromPath } from '../src/registry/index.js';

// The registry is a global singleton: it is cleared between tests
beforeEach(() => {
    (registry as any).registry = new Map();
});

const fakeModule = () => Promise.resolve({ default: () => null });

describe('blockTypeFromPath', () => {
    test('uses the file name without extension', () => {
        expect(blockTypeFromPath('/src/blocks/HeroBanner.astro')).toBe('HeroBanner');
    });

    test('works with nested paths', () => {
        expect(blockTypeFromPath('/src/blocks/marketing/PricingTable.astro')).toBe('PricingTable');
    });

    test('works with any extension', () => {
        expect(blockTypeFromPath('/src/blocks/Counter.svelte')).toBe('Counter');
        expect(blockTypeFromPath('/src/blocks/Chart.tsx')).toBe('Chart');
    });

    test('tolerates a path without a directory', () => {
        expect(blockTypeFromPath('Hero.astro')).toBe('Hero');
    });
});

describe('registerBlocks', () => {
    test('registers the whole glob and returns the types', () => {
        const registered = registerBlocks({
            '/src/blocks/HeroBanner.astro': fakeModule,
            '/src/blocks/TwoColumn.astro': fakeModule
        });

        expect(registered.sort()).toEqual(['HeroBanner', 'TwoColumn']);
        expect(registry.has('HeroBanner')).toBe(true);
        expect(registry.has('TwoColumn')).toBe(true);
    });

    test('the registered type matches what the adapters produce', () => {
        // WordPress normalizes acf_fc_layout 'hero_banner' → 'HeroBanner',
        // so the HeroBanner.astro file must match without configuring anything
        registerBlocks({ '/src/blocks/HeroBanner.astro': fakeModule });

        expect(registry.get('HeroBanner')).toBeDefined();
    });

    test('stores the loader as is so it stays lazy', async () => {
        let loaded = false;
        const loader = async () => {
            loaded = true;
            return { default: () => null };
        };

        registerBlocks({ '/src/blocks/Hero.astro': loader });

        // Registering must not load the module
        expect(loaded).toBe(false);

        await registry.get('Hero')!.component();
        expect(loaded).toBe(true);
    });

    test('applies the client directive and the framework', () => {
        registerBlocks({ '/src/blocks/Counter.svelte': fakeModule }, {
            clientDirective: 'visible',
            framework: 'svelte'
        });

        const registration = registry.get('Counter')!;
        expect(registration.clientDirective).toBe('visible');
        expect(registration.framework).toBe('svelte');
    });

    test('accepts a custom name mapping', () => {
        registerBlocks(
            { '/src/blocks/hero-banner.astro': fakeModule },
            { typeFromPath: (path) => path.split('/').pop()!.replace('.astro', '').replace(/-/g, '_') }
        );

        expect(registry.has('hero_banner')).toBe(true);
    });

    test('an empty glob neither breaks nor registers anything', () => {
        expect(registerBlocks({})).toEqual([]);
    });

    test('ignores entries that are not functions', () => {
        // import.meta.glob with eager:true returns modules, not loaders
        const registered = registerBlocks({
            '/src/blocks/Hero.astro': fakeModule,
            '/src/blocks/Broken.astro': { default: () => null } as any
        });

        expect(registered).toEqual(['Hero']);
    });

    test('registering again replaces instead of duplicating', () => {
        const first = async () => ({ default: 'first' as any });
        const second = async () => ({ default: 'second' as any });

        registerBlocks({ '/src/blocks/Hero.astro': first });
        registerBlocks({ '/src/blocks/Hero.astro': second });

        expect(registry.get('Hero')!.component).toBe(second);
    });

    test('the manifest is populated for the AI generator', () => {
        registerBlocks({
            '/src/blocks/HeroBanner.astro': fakeModule,
            '/src/blocks/TwoColumn.astro': fakeModule
        });

        const manifest = registry.getManifest();

        expect(Object.keys(manifest).sort()).toEqual(['HeroBanner', 'TwoColumn']);
        expect(manifest.HeroBanner.label).toBe('HeroBanner');
    });
});
