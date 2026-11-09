import type { Transformer, TransformContext, TransformedContent, MarkdownOptions } from './types.js';

/**
 * Markdown Transformer
 * Converts Markdown content to HTML
 */
export class MarkdownTransformer implements Transformer<string, TransformedContent> {
    name = 'markdown';
    contentTypes = ['markdown', 'md'];
    
    private options: MarkdownOptions;

    constructor(options: MarkdownOptions = {}) {
        this.options = {
            gfm: true,
            breaks: false,
            sanitize: true,
            ...options
        };
    }

    async transform(content: string, context: TransformContext): Promise<TransformedContent> {
        // Simple markdown parsing (can be enhanced with libraries like marked, remark)
        const html = this.parseMarkdown(content);
        const plainText = this.extractPlainText(html);
        const headings = this.extractHeadings(html);
        const wordCount = plainText.split(/\s+/).length;
        const readingTime = Math.ceil(wordCount / 200); // ~200 WPM

        return {
            html,
            plainText,
            headings,
            toc: headings,
            metadata: {
                readingTime,
                wordCount
            }
        };
    }

    private parseMarkdown(markdown: string): string {
        let html = markdown;

        // Headers
        html = html.replace(/^###### (.*$)/gim, '<h6>$1</h6>');
        html = html.replace(/^##### (.*$)/gim, '<h5>$1</h5>');
        html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

        // Bold and Italic
        html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
        html = html.replace(/_(.*?)_/g, '<em>$1</em>');

        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

        // Images
        html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');

        // Code blocks
        html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Blockquotes
        html = html.replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>');

        // Lists
        html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
        html = html.replace(/^- (.*$)/gim, '<li>$1</li>');
        html = html.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
        html = html.replace(/<ul>(<li>.*<\/li>\n?)+<\/ul>/g, match => {
            if (match.includes('<ul>')) {
                return '<ul>' + match.replace(/<\/?ul>/g, '') + '</ul>';
            }
            return match;
        });

        // Horizontal rule
        html = html.replace(/^---$/gim, '<hr />');

        // Line breaks
        if (this.options.breaks) {
            html = html.replace(/\n/g, '<br />');
        } else {
            html = html.replace(/\n\n/g, '</p><p>');
        }

        // Wrap in paragraphs if not already wrapped
        if (!html.startsWith('<')) {
            html = `<p>${html}</p>`;
        }

        return html;
    }

    private extractPlainText(html: string): string {
        return html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private extractHeadings(html: string): Array<{ level: number; text: string; id: string }> {
        const headings: Array<{ level: number; text: string; id: string }> = [];
        const regex = /<h([1-6])>([^<]+)<\/h[1-6]>/g;
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
