/**
 * @module commands/generate
 * CLI command handler for `inti generate`.
 * Introspects the CMS schema via the configured adapter and generates
 * ready-to-use Astro component files in the project.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { generateAstroComponents } from '../generator/index.js';
import type { ComponentGeneratorOptions } from '../generator/index.js';

// ============================================
// Command Options
// ============================================

export interface GenerateCommandOptions {
    /** Directory to write generated components into */
    outputDir?: string;
    /** Whether to overwrite existing component files */
    overwrite?: boolean;
    /** Style preset: 'minimal' (no classes) or 'styled' (Tailwind/UnoCSS) */
    style?: string;
}

// ============================================
// Command Implementation
// ============================================

/**
 * Execute the `inti generate` command.
 *
 * Loads the project config, resolves the CMS adapter, introspects the schema,
 * generates `.astro` components for each collection, and writes them to disk.
 *
 * @param configPath - Path to the inti config file (default: `./inti.config.ts`)
 * @param options    - Optional overrides for output directory, overwrite, and style
 */
export async function generateCommand(
    configPath: string = './inti.config.ts',
    options?: GenerateCommandOptions,
): Promise<void> {
    console.log('🧩 Starting Inti Component Generation...');

    try {
        // Step 1: Load config
        const fullConfigPath = resolve(process.cwd(), configPath);
        if (!existsSync(fullConfigPath)) {
            console.error(`❌ Config file not found at ${fullConfigPath}`);
            process.exit(1);
        }

        const config = await loadConfig(fullConfigPath);
        console.log(`📡 Using adapter: ${config.adapter}`);

        // Step 2: Resolve and initialise adapter
        const AdapterClass = await resolveAdapterClass(config.adapter);
        const adapter = new AdapterClass(config.adapterConfig);

        // Step 3: Introspect CMS
        console.log('🔍 Introspecting CMS schema...');
        const schema = await adapter.introspect();
        console.log(`   Found ${schema.collections.length} collections.`);

        if (schema.collections.length === 0) {
            console.log('⚠️  No collections found — nothing to generate.');
            return;
        }

        // Step 4: Resolve options
        const outputDir = resolve(
            process.cwd(),
            options?.outputDir || config.componentsDir || './src/components/blocks',
        );
        const overwrite = options?.overwrite ?? false;
        const style = (options?.style === 'minimal' ? 'minimal' : 'styled') as ComponentGeneratorOptions['style'];

        // Ensure output directory exists
        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }

        // Step 5: Generate components
        console.log('\n🧱 Generating Astro components...');

        const generatorOptions: ComponentGeneratorOptions = {
            outputDir,
            overwrite,
            style,
            includeProps: true,
            includeJsDoc: true,
        };

        const components = generateAstroComponents(schema, generatorOptions);

        // Step 6: Write to disk
        let created = 0;
        let skipped = 0;

        for (const component of components) {
            const filePath = resolve(outputDir, component.filename);
            const exists = existsSync(filePath);

            if (exists && !overwrite) {
                component.isNew = false;
                skipped++;
                console.log(`   ⏭️  Skipped (exists): ${component.filename}`);
                continue;
            }

            writeFileSync(filePath, component.content, 'utf-8');
            component.isNew = !exists;
            created++;
            console.log(`   ✅ ${exists ? 'Overwrote' : 'Created'}:  ${filePath.replace(process.cwd(), '.')}`);
        }

        // Step 7: Summary
        console.log('\n─────────────────────────────────────');
        console.log(`🎉 Component generation complete!`);
        console.log(`   📂 Output:   ${outputDir.replace(process.cwd(), '.')}`);
        console.log(`   ✅ Created:  ${created}`);
        if (skipped > 0) {
            console.log(`   ⏭️  Skipped:  ${skipped} (use --overwrite to replace)`);
        }
        console.log('─────────────────────────────────────\n');

    } catch (error) {
        console.error('❌ Generation failed:');
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

// ============================================
// Internal Helpers (mirrored from sync.ts)
// ============================================

/**
 * Load config from file
 */
async function loadConfig(configPath: string): Promise<any> {
    try {
        const fileUrl = pathToFileURL(configPath).href;
        const module = await import(fileUrl);
        const config = module.default || module;

        if (!config.adapter) {
            throw new Error('Config must specify "adapter"');
        }

        return config;
    } catch (error) {
        throw new Error(`Failed to load config: ${error instanceof Error ? error.message : error}`);
    }
}

/**
 * Resolve adapter class dynamically
 */
async function resolveAdapterClass(adapterName: string): Promise<any> {
    const tryPackages = [
        `@intijs/adapter-${adapterName}`,
        `inti-adapter-${adapterName}`,
    ];

    for (const pkg of tryPackages) {
        try {
            const module = await import(pkg);
            const AdapterClass = module.default || Object.values(module).find((v: any) => typeof v === 'function');
            if (AdapterClass) {
                return AdapterClass;
            }
        } catch {
            continue;
        }
    }

    // Fallback to internal core adapters if name matches
    if (adapterName === 'contentful' || adapterName === 'strapi' || adapterName === 'sanity' || adapterName === 'gremius') {
        try {
            const pkg = `@intijs/core/adapters`;
            const module = await import(pkg);
            const className = `${adapterName.charAt(0).toUpperCase()}${adapterName.slice(1)}Adapter`;
            if (module[className]) return module[className];
        } catch {}
    }

    throw new Error(
        `Adapter "${adapterName}" not found.\n` +
        `Try installing: bun add @intijs/adapter-${adapterName}`,
    );
}
