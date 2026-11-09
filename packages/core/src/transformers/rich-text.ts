import type { Transformer, TransformContext, TransformedContent } from './types.js';
import type { RichTextDocument, RichTextNode } from './types.js';

/**
 * Rich Text Transformer
 * Converts structured rich text (like from Contentful, Sanity, Strapi) to HTML
 * Supports multiple formats: ProseMirror, Slate, etc.
 */
export class RichTextTransformer implements Transformer<RichTextDocument | RichTextNode[], TransformedContent> {
    name = 'rich-text';
    contentTypes = ['rich-text', 'richtext', 'prosemirror', 'slate', 'blocks'];
    
    private nodeRenderers: Map<string, (node: RichTextNode) => string>;

    constructor() {
        this.nodeRenderers = new Map([
            ['paragraph', this.renderParagraph.bind(this)],
            ['text', this.renderText.bind(this)],
            ['heading', this.renderHeading.bind(this)],
            ['bullet_list', this.renderBulletList.bind(this)],
            ['ordered_list', this.renderOrderedList.bind(this)],
            ['list_item', this.renderListItem.bind(this)],
            ['blockquote', this.renderBlockquote.bind(this)],
            ['code_block', this.renderCodeBlock.bind(this)],
            ['hard_break', () => '<br />'],
            ['horizontal_rule', () => '<hr />'],
            ['image', this.renderImage.bind(this)],
            ['link', this.renderLink.bind(this)],
            ['embed', this.renderEmbed.bind(this)],
        ]);
    }

    async transform(content: RichTextDocument | RichTextNode[], context: TransformContext): Promise<TransformedContent> {
        const nodes = Array.isArray(content) ? content : content.content;
        const html = this.renderNodes(nodes);
        const plainText = this.extractPlainText(nodes);
        const headings = this.extractHeadings(nodes);
        const wordCount = plainText.split(/\s+/).filter(w => w.length > 0).length;
        const readingTime = Math.ceil(wordCount / 200);

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

    private renderNodes(nodes: RichTextNode[]): string {
        return nodes.map(node => this.renderNode(node)).join('');
    }

    private renderNode(node: RichTextNode): string {
        const renderer = this.nodeRenderers.get(node.type);
        
        if (renderer) {
            return renderer(node);
        }
        
        // Fallback: render children or text
        if (node.content) {
            return this.renderNodes(node.content);
        }
        
        return node.text || '';
    }

    private renderParagraph(node: RichTextNode): string {
        const content = node.content ? this.renderNodes(node.content) : '';
        return `<p>${content}</p>`;
    }

    private renderText(node: RichTextNode): string {
        let text = node.text || '';
        
        // Apply marks (formatting)
        if (node.marks) {
            for (const mark of node.marks) {
                switch (mark.type) {
                    case 'bold':
                    case 'strong':
                        text = `<strong>${text}</strong>`;
                        break;
                    case 'italic':
                    case 'em':
                        text = `<em>${text}</em>`;
                        break;
                    case 'code':
                        text = `<code>${text}</code>`;
                        break;
                    case 'underline':
                        text = `<u>${text}</u>`;
                        break;
                    case 'strike':
                    case 'strikethrough':
                        text = `<s>${text}</s>`;
                        break;
                    case 'link':
                        const href = mark.attrs?.href || '#';
                        const target = mark.attrs?.target ? ` target="${mark.attrs.target}"` : '';
                        text = `<a href="${href}"${target}>${text}</a>`;
                        break;
                    case 'superscript':
                        text = `<sup>${text}</sup>`;
                        break;
                    case 'subscript':
                        text = `<sub>${text}</sub>`;
                        break;
                }
            }
        }
        
        return text;
    }

    private renderHeading(node: RichTextNode): string {
        const level = node.attrs?.level || 1;
        const content = node.content ? this.renderNodes(node.content) : '';
        const id = content.toLowerCase().replace(/[^\w]+/g, '-');
        return `<h${level} id="${id}">${content}</h${level}>`;
    }

    private renderBulletList(node: RichTextNode): string {
        const items = node.content ? this.renderNodes(node.content) : '';
        return `<ul>${items}</ul>`;
    }

    private renderOrderedList(node: RichTextNode): string {
        const items = node.content ? this.renderNodes(node.content) : '';
        return `<ol>${items}</ol>`;
    }

    private renderListItem(node: RichTextNode): string {
        const content = node.content ? this.renderNodes(node.content) : '';
        return `<li>${content}</li>`;
    }

    private renderBlockquote(node: RichTextNode): string {
        const content = node.content ? this.renderNodes(node.content) : '';
        return `<blockquote>${content}</blockquote>`;
    }

    private renderCodeBlock(node: RichTextNode): string {
        const language = node.attrs?.language || '';
        const content = node.content ? this.renderNodes(node.content) : '';
        return `<pre><code class="language-${language}">${content}</code></pre>`;
    }

    private renderImage(node: RichTextNode): string {
        const src = node.attrs?.src || '';
        const alt = node.attrs?.alt || '';
        const title = node.attrs?.title;
        const width = node.attrs?.width;
        const height = node.attrs?.height;
        
        let imgTag = `<img src="${src}" alt="${alt}"`;
        if (title) imgTag += ` title="${title}"`;
        if (width) imgTag += ` width="${width}"`;
        if (height) imgTag += ` height="${height}"`;
        imgTag += ' />';
        
        return imgTag;
    }

    private renderLink(node: RichTextNode): string {
        const href = node.attrs?.href || '#';
        const target = node.attrs?.target ? ` target="${node.attrs.target}"` : '';
        const content = node.content ? this.renderNodes(node.content) : '';
        return `<a href="${href}"${target}>${content}</a>`;
    }

    private renderEmbed(node: RichTextNode): string {
        const type = node.attrs?.type || 'generic';
        const url = node.attrs?.url || '';
        
        // Handle common embed types
        switch (type) {
            case 'youtube':
                const videoId = this.extractYouTubeId(url);
                return `<iframe width="560" height="315" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe>`;
            case 'vimeo':
                const vimeoId = this.extractVimeoId(url);
                return `<iframe width="560" height="315" src="https://player.vimeo.com/video/${vimeoId}" frameborder="0" allowfullscreen></iframe>`;
            case 'twitter':
                return `<blockquote class="twitter-tweet"><a href="${url}"></a></blockquote>`;
            default:
                return `<div class="embed" data-type="${type}" data-url="${url}"><a href="${url}" target="_blank">${url}</a></div>`;
        }
    }

    private extractYouTubeId(url: string): string {
        const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s]+)/);
        return match?.[1] || '';
    }

    private extractVimeoId(url: string): string {
        const match = url.match(/vimeo\.com\/(\d+)/);
        return match?.[1] || '';
    }

    private extractPlainText(nodes: RichTextNode[]): string {
        return nodes.map(node => {
            if (node.text) return node.text;
            if (node.content) return this.extractPlainText(node.content);
            return '';
        }).join(' ');
    }

    private extractHeadings(nodes: RichTextNode[]): Array<{ level: number; text: string; id: string }> {
        const headings: Array<{ level: number; text: string; id: string }> = [];
        
        for (const node of nodes) {
            if (node.type === 'heading') {
                const level = node.attrs?.level || 1;
                const text = this.extractPlainText(node.content || []);
                const id = text.toLowerCase().replace(/[^\w]+/g, '-');
                headings.push({ level, text, id });
            }
            
            if (node.content) {
                headings.push(...this.extractHeadings(node.content));
            }
        }
        
        return headings;
    }
}
