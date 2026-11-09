/**
 * Transformer System Types
 * Content transformation pipeline (MDX, Rich Text, Markdown)
 */

export interface TransformContext {
    contentType: string;
    fieldPath: string;
    locale?: string;
    metadata?: Record<string, any>;
}

export interface Transformer<T = any, R = any> {
    name: string;
    contentTypes: string[];
    transform: (content: T, context: TransformContext) => Promise<R> | R;
}

export interface TransformedContent {
    html: string;
    plainText?: string;
    headings?: Array<{ level: number; text: string; id: string }>;
    toc?: Array<{ level: number; text: string; id: string }>;
    frontmatter?: Record<string, any>;
    metadata?: {
        readingTime?: number;
        wordCount?: number;
    };
}

export interface MarkdownOptions {
    gfm?: boolean;
    breaks?: boolean;
    sanitize?: boolean;
    plugins?: string[];
}

export interface MDXOptions extends MarkdownOptions {
    components?: Record<string, any>;
    remarkPlugins?: any[];
    rehypePlugins?: any[];
}

export interface RichTextNode {
    type: string;
    text?: string;
    marks?: Array<{ type: string; attrs?: Record<string, any> }>;
    attrs?: Record<string, any>;
    content?: RichTextNode[];
}

export interface RichTextDocument {
    type: 'doc';
    content: RichTextNode[];
}
