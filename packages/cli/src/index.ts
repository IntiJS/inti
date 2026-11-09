// CLI exports
export { syncCommand } from './commands/sync.js';
export { devCommand } from './commands/dev.js';
export { generateCommand } from './commands/generate.js';
export type { GenerateCommandOptions } from './commands/generate.js';

// Generator exports
export { generateTypeDefinitions } from './generator/index.js';
export { generateAstroComponents } from './generator/index.js';
export type { ComponentGeneratorOptions, GeneratedComponent } from './generator/index.js';
