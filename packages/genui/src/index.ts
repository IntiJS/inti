/**
 * @intijs/genui — a model composes pages with the blocks you declared.
 *
 * The model picks components and fills in fields. It generates no HTML, CSS or code,
 * and everything it produces is validated in shape and content before it is used.
 *
 * The Anthropic provider lives separately in `@intijs/genui/anthropic`: the rest of
 * the package works with any `AiProvider`.
 */

export { defineVocabulary, fromData, sourcesUsed } from './vocabulary.js';
export type {
    BooleanField,
    DataItem,
    DataSource,
    DataSources,
    GeneratorField,
    ListField,
    NumberField,
    ObjectField,
    ReferenceField,
    RichTextField,
    TextField,
    UrlField,
    Vocabulary,
    VocabularyBlock
} from './vocabulary.js';

export { buildBlockSchema } from './schema.js';
export type { Candidates } from './schema.js';

export { validateBlock, validateGenerated } from './validate.js';
export type { GeneratedBlock, ValidationResult } from './validate.js';

export { isDangerousText, safeUrl, sanitizeRichText } from './sanitize.js';

export { BlockStreamParser } from './stream-parser.js';

export { compose, composeStream, createBlockGenerator, SYSTEM_PROMPT } from './compose.js';
export type { AiProvider, BlockGeneratorConfig, ComposeEvent, ComposeOptions, GenerateRequest } from './compose.js';

export { createVisitorComposer, VISITOR_HEADERS } from './visitor.js';
export type { VisitorCache, VisitorComposerConfig, VisitorLimiter, VisitorLimits, VisitorResult, VisitorStatus } from './visitor.js';

export { createVocabularyTool } from './tools.js';
export type { VocabularyToolOptions } from './tools.js';

export { createComposePipeline, cachedGeneration, personalizedRequest } from './pipeline.js';
export type { ComposePipeline, ContextFrame, Frame, GenerationFrame, Processor, RequestFrame, ResultFrame } from './pipeline.js';

export { validateRecipe, recipeToPipeline, runRecipe } from './recipe.js';
export type { FlowRecipe, RecipeDeps, RecipeStage } from './recipe.js';
