import type { Transformer, TransformContext, TransformedContent } from './types.js';

/**
 * Transformer Pipeline
 * Orchestrates multiple transformers for content processing
 */
export class TransformerPipeline {
    private transformers: Map<string, Transformer> = new Map();
    private defaultTransformer: Transformer | null = null;

    register(transformer: Transformer): void {
        this.transformers.set(transformer.name, transformer);
        
        // Register for each content type
        for (const contentType of transformer.contentTypes) {
            this.transformers.set(`__type_${contentType}`, transformer);
        }
    }

    setDefault(transformer: Transformer): void {
        this.defaultTransformer = transformer;
    }

    async transform<T = any>(
        content: T, 
        contentType: string, 
        context: Partial<TransformContext> = {}
    ): Promise<TransformedContent> {
        const fullContext: TransformContext = {
            contentType,
            fieldPath: context.fieldPath || 'content',
            locale: context.locale,
            metadata: context.metadata
        };

        // Find transformer by content type
        let transformer = this.transformers.get(`__type_${contentType}`) 
            || this.transformers.get(contentType) 
            || this.defaultTransformer;

        if (!transformer) {
            throw new Error(`No transformer found for content type: ${contentType}`);
        }

        return transformer.transform(content, fullContext);
    }

    hasTransformer(contentType: string): boolean {
        return this.transformers.has(`__type_${contentType}`) || 
               this.transformers.has(contentType) ||
               this.defaultTransformer !== null;
    }

    getRegisteredTransformers(): string[] {
        return Array.from(new Set(
            Array.from(this.transformers.values()).map(t => t.name)
        ));
    }
}

// Global pipeline instance
const globalPipeline = new TransformerPipeline();

export function getPipeline(): TransformerPipeline {
    return globalPipeline;
}

export function transformContent<T = any>(
    content: T,
    contentType: string,
    context?: Partial<TransformContext>
): Promise<TransformedContent> {
    return globalPipeline.transform(content, contentType, context);
}
