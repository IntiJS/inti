import type { Transformer, TransformContext, TransformedContent, MDXOptions } from './types.js';

/**
 * MDX Transformer
 * Converts MDX content to renderable components
 */
export class MDXTransformer implements Transformer<string, TransformedContent> {
    name = 'mdx';
    contentTypes = ['mdx'];
    
    private options: MDXOptions;

    constructor(options: MDXOptions = {}) {
        this.options = {
            gfm: true,
            breaks: false,
            ...options
        };
    }

    async transform(content: string, context: TransformContext): Promise<TransformedContent> {
        // Extract frontmatter
        const { frontmatter, body } = this.extractFrontmatter(content);
        
        // Process MDX content (simplified - in production would use @mdx-js/mdx)
        const html = await this.processMDX(body, context);
        const plainText = this.extractPlainText(html);
        const headings = this.extractHeadings(html);
        const wordCount = plainText.split(/\s+/).length;
        const readingTime = Math.ceil(wordCount / 200);

        return {
            html,
            plainText,
            headings,
            toc: headings,
            frontmatter,
            metadata: {
                readingTime,
                wordCount
            }
        };
    }

    private extractFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
        const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
        const match = content.match(frontmatterRegex);
        
        if (!match) {
            return { frontmatter: {}, body: content };
        }

        const frontmatterText = match[1];
        const body = content.slice(match[0].length);
        const frontmatter: Record<string, any> = {};

        // Simple YAML parsing
        frontmatterText.split('\n').forEach(line => {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.slice(0, colonIndex).trim();
                let value: any = line.slice(colonIndex + 1).trim();
                
                // Try to parse as number or boolean
                if (value === 'true') value = true;
                else if (value === 'false') value = false;
                else if (!isNaN(Number(value))) value = Number(value);
                else if (value.startsWith('[') && value.endsWith(']')) {
                    // Array
                    value = value.slice(1, -1).split(',').map((item: string) => item.trim());
                }
                
                frontmatter[key] = value;
            }
        });

        return { frontmatter, body };
    }

    private async processMDX(content: string, context: TransformContext): Promise<string> {
        // Replace JSX components with placeholders
        // In production, this would compile to actual component imports
        let html = content;

        // Handle JSX components like <Component prop="value" />
        html = html.replace(/<(\w+)([^>]*)\/>/g, (match, tagName, attrs) => {
            const props = this.parseJSXAttributes(attrs);
            return `<div class="mdx-component" data-component="${tagName}" data-props='${JSON.stringify(props)}'></div>`;
        });

        // Handle JSX blocks with children
        html = html.replace(/<(\w+)([^>]*)>([\s\S]*?)<\/\1>/g, (match, tagName, attrs, children) => {
            if (tagName === 'p' || tagName === 'div' || tagName === 'span') {
                return match; // Regular HTML
            }
            const props = this.parseJSXAttributes(attrs);
            return `<div class="mdx-component" data-component="${tagName}" data-props='${JSON.stringify(props)}'>${children}</div>`;
        });

        // Apply markdown transformations
        const markdownTransformer = new (await import('./markdown.js')).MarkdownTransformer(this.options);
        const result = await markdownTransformer.transform(html, context);
        
        return result.html;
    }

    private parseJSXAttributes(attrs: string): Record<string, any> {
        const props: Record<string, any> = {};
        const regex = /(\w+)=(?:"([^"]*)"|\{([^}]*)\})/g;
        let match;
        
        while ((match = regex.exec(attrs)) !== null) {
            const key = match[1];
            const stringValue = match[2];
            const expressionValue = match[3];
            
            if (expressionValue !== undefined) {
                // Try to parse as JSON
                try {
                    props[key] = JSON.parse(expressionValue);
                } catch {
                    props[key] = expressionValue;
                }
            } else {
                props[key] = stringValue;
            }
        }
        
        return props;
    }

    private extractPlainText(html: string): string {
        return html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private extractHeadings(html: string): Array<{ level: number; text: string; id: string }> {
        const headings: Array<{ level: number; text: string; id: string }> = [];
        const regex = /<h([1-6])(?:[^>]*)>([^<]+)<\/h[1-6]>/g;
        let match;
        
        while ((match = regex.exec(html)) !== null) {
            const text = match[2].trim();
            const id = text.toLowerCase().replace(/[^\w]+/g, '-');
            headings.push({
                level: parseInt(match[1]),
                text,
                id
            });
        }
        
        return headings;
    }
}
