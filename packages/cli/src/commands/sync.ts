import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

// Import generators directly
import { generateTypeDefinitions, generateAIManifest, generateMockData } from '../generator/index.js';
import { registry } from '@intijs/core/registry';

export async function syncCommand(configPath: string = './inti.config.ts') {
    console.log('🚀 Starting Inti Sync...');

    try {
        // Step 1: Load config
        const fullConfigPath = resolve(process.cwd(), configPath);
        if (!existsSync(fullConfigPath)) {
            console.error(`❌ Config file not found at ${fullConfigPath}`);
            process.exit(1);
        }

        const config = await loadConfig(fullConfigPath);
        console.log(`📡 Using adapter: ${config.adapter}`);

        // Step 2: Resolve and initialize adapter
        const AdapterClass = await resolveAdapterClass(config.adapter);
        const adapter = new AdapterClass(config.adapterConfig);

        // Step 3: Introspect CMS
        console.log('🔍 Introspecting CMS schema...');
        const schema = await adapter.introspect();
        console.log(`   Found ${schema.collections.length} collections.`);

        // Step 4: Generate code
        const finalOutputDir = resolve(process.cwd(), config.outputDir || './src/lib/inti');

        // Ensure output directory exists
        if (!existsSync(finalOutputDir)) {
            mkdirSync(finalOutputDir, { recursive: true });
        }

        // Generate types file
        console.log('\n📝 Generating TypeScript types...');
        const typesContent = generateTypeDefinitions(schema);
        const typesPath = resolve(finalOutputDir, 'inti.types.ts');
        writeFileSync(typesPath, typesContent);
        console.log(`   ✓ Generated: ${typesPath.replace(process.cwd(), '.')}`);

        // Development versions also generated inti-sdk.ts, with functions that
        // requested `${endpoint}/api/<collection>`: a route that no supported
        // CMS has. Content is read with the adapter. A user's file is not
        // deleted without asking; we warn instead.
        const legacySdk = resolve(finalOutputDir, 'inti-sdk.ts');
        if (existsSync(legacySdk)) {
            console.warn(
                `   ⚠ ${legacySdk.replace(process.cwd(), '.')} is from an earlier development version and its functions do not ` +
                    'work with any supported CMS. Delete it and read content with the adapter.'
            );
        }

        // Step 5: AI-Native Generation
        console.log('🤖 Generating AI Discovery Manifest...');
        const manifest = registry.getManifest ? registry.getManifest() : {};
        const manifestPath = generateAIManifest(manifest, finalOutputDir);
        console.log(`   ✓ Generated: ${manifestPath.replace(process.cwd(), '.')}`);

        console.log('🧪 Generating Mock Data examples...');
        const mocksPath = generateMockData(manifest, finalOutputDir);
        console.log(`   ✓ Generated: ${mocksPath.replace(process.cwd(), '.')}`);

        // Success
        console.log('\n✅ Synchronization complete!');

    } catch (error) {
        console.error('❌ Sync failed:');
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

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
        `inti-adapter-${adapterName}`
    ];

    for (const pkg of tryPackages) {
        try {
            const module = await import(pkg);
            // Try default export first, then look for any exported function
            const AdapterClass = module.default || Object.values(module).find((v: any) => typeof v === 'function');
            if (AdapterClass) {
                return AdapterClass;
            }
        } catch {
            continue;
        }
    }

    // Fallback to internal core adapters if name matches
    if (adapterName === 'contentful' || adapterName === 'strapi' || adapterName === 'sanity' || adapterName === 'kitsuden') {
        try {
            const pkg = `@intijs/core/adapters`;
            const module = await import(pkg);
            const className = `${adapterName.charAt(0).toUpperCase()}${adapterName.slice(1)}Adapter`;
            if (module[className]) return module[className];
        } catch {}
    }

    throw new Error(
        `Adapter "${adapterName}" not found.\n` +
        `Try installing: bun add @intijs/adapter-${adapterName}`
    );
}
