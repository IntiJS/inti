import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

/**
 * AI Manifest Generator
 * Generates a JSON file describing all available Inti blocks.
 * This file acts as a "source of truth" for AI agents to understand
 * what components can be used to build pages.
 */
export function generateAIManifest(manifest: Record<string, any>, outputDir: string): string {
    const manifestPath = resolve(outputDir, 'inti-manifest.json');
    
    // Enrich manifest with AI instructions
    const aiManifest = {
        _instructions: {
            goal: "Use this manifest to construct valid IntiPage and IntiBlock structures.",
            blockRules: "Each block in 'blocks' object contains metadata about its component. 'type' matches the 'type' field in an IntiBlock.",
            mapping: "When building a page, map CMS fields to the properties defined in these blocks.",
            styles: "Components are styled with UnoCSS (Tailwind-compatible). Use utility classes for customization."
        },
        blocks: manifest,
        projectRules: "Blocks are declared in code and composed by editors. Never invent block types that are not listed here."
    };

    writeFileSync(manifestPath, JSON.stringify(aiManifest, null, 2));
    return manifestPath;
}

/**
 * Mock Data Generator
 * Generates example JSON structures for the CMS based on the manifest.
 * This helps AI agents create realistic test data.
 */
export function generateMockData(manifest: Record<string, any>, outputDir: string): string {
    const mocksPath = resolve(outputDir, 'inti-mocks.ts');
    const mocks: Record<string, any> = {};

    for (const [type, reg] of Object.entries(manifest)) {
        mocks[type] = (reg as any).mockData || {
            title: `Example ${type}`,
            description: `This is a high-quality placeholder for the ${type} block, designed to help AI agents understand the expected structure.`,
            content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
            image: {
                url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe",
                alt: `Placeholder for ${type}`
            }
        };
    }

    const content = `/**
 * Inti Mock Data
 * Generated automatically. Use these examples for testing and AI prompting.
 */

export const IntiMocks = ${JSON.stringify(mocks, null, 2)};

export default IntiMocks;
`;

    writeFileSync(mocksPath, content);
    return mocksPath;
}
