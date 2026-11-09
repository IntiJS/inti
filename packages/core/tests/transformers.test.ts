import { describe, it, expect } from 'bun:test';
import { 
    MarkdownTransformer, 
    MDXTransformer, 
    RichTextTransformer,
    TransformerPipeline,
    transformContent 
} from '../src/transformers/index.js';
import type { RichTextDocument, RichTextNode } from '../src/transformers/types.js';

describe('Transformers', () => {
    describe('MarkdownTransformer', () => {
        const transformer = new MarkdownTransformer();

        it('should transform headers', async () => {
            const markdown = '# Heading 1\n## Heading 2';
            const result = await transformer.transform(markdown, {
                contentType: 'markdown',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<h1>Heading 1</h1>');
            expect(result.html).toContain('<h2>Heading 2</h2>');
        });

        it('should transform bold and italic', async () => {
            const markdown = '**bold** and *italic*';
            const result = await transformer.transform(markdown, {
                contentType: 'markdown',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<strong>bold</strong>');
            expect(result.html).toContain('<em>italic</em>');
        });

        it('should transform links', async () => {
            const markdown = '[Link text](https://example.com)';
            const result = await transformer.transform(markdown, {
                contentType: 'markdown',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<a href="https://example.com">Link text</a>');
        });

        it('should extract headings for TOC', async () => {
            const markdown = '# First\nContent\n## Second\nMore content';
            const result = await transformer.transform(markdown, {
                contentType: 'markdown',
                fieldPath: 'content'
            });

            expect(result.headings).toHaveLength(2);
            expect(result.headings?.[0].text).toBe('First');
            expect(result.headings?.[1].level).toBe(2);
        });

        it('should calculate reading time', async () => {
            const markdown = 'word '.repeat(400); // 400 words = ~2 minutes
            const result = await transformer.transform(markdown, {
                contentType: 'markdown',
                fieldPath: 'content'
            });

            expect(result.metadata?.readingTime).toBe(2);
            expect(result.metadata?.wordCount).toBe(400);
        });

        it('should handle lists', async () => {
            const markdown = '- Item 1\n- Item 2\n- Item 3';
            const result = await transformer.transform(markdown, {
                contentType: 'markdown',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<ul>');
            expect(result.html).toContain('<li>Item 1</li>');
        });

        it('should handle code blocks', async () => {
            const markdown = '```typescript\nconst x = 1;\n```';
            const result = await transformer.transform(markdown, {
                contentType: 'markdown',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<pre><code');
            expect(result.html).toContain('language-typescript');
        });

        it('should extract plain text', async () => {
            const markdown = '# Title\nSome **bold** content';
            const result = await transformer.transform(markdown, {
                contentType: 'markdown',
                fieldPath: 'content'
            });

            expect(result.plainText).toContain('Title');
            expect(result.plainText).toContain('bold');
            expect(result.plainText).not.toContain('<h1>');
        });
    });

    describe('MDXTransformer', () => {
        const transformer = new MDXTransformer();

        it('should extract frontmatter', async () => {
            const mdx = `---
title: My Post
author: John Doe
published: true
---
# Content`;

            const result = await transformer.transform(mdx, {
                contentType: 'mdx',
                fieldPath: 'content'
            });

            expect(result.frontmatter?.title).toBe('My Post');
            expect(result.frontmatter?.author).toBe('John Doe');
            expect(result.frontmatter?.published).toBe(true);
        });

        it('should process markdown content', async () => {
            const mdx = '---\ntitle: Test\n---\n# Hello World';
            const result = await transformer.transform(mdx, {
                contentType: 'mdx',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<h1>Hello World</h1>');
        });

        it('should handle MDX without frontmatter', async () => {
            const mdx = '# Just Markdown';
            const result = await transformer.transform(mdx, {
                contentType: 'mdx',
                fieldPath: 'content'
            });

            expect(result.frontmatter).toEqual({});
            expect(result.html).toContain('<h1>Just Markdown</h1>');
        });
    });

    describe('RichTextTransformer', () => {
        const transformer = new RichTextTransformer();

        it('should transform paragraphs', async () => {
            const doc: RichTextDocument = {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Hello world' }]
                }]
            };

            const result = await transformer.transform(doc, {
                contentType: 'rich-text',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<p>Hello world</p>');
        });

        it('should transform headings with IDs', async () => {
            const doc: RichTextDocument = {
                type: 'doc',
                content: [{
                    type: 'heading',
                    attrs: { level: 2 },
                    content: [{ type: 'text', text: 'Section Title' }]
                }]
            };

            const result = await transformer.transform(doc, {
                contentType: 'rich-text',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<h2 id="section-title">Section Title</h2>');
        });

        it('should apply marks (bold, italic)', async () => {
            const doc: RichTextDocument = {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Bold ', marks: [{ type: 'bold' }] },
                        { type: 'text', text: 'italic', marks: [{ type: 'italic' }] }
                    ]
                }]
            };

            const result = await transformer.transform(doc, {
                contentType: 'rich-text',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<strong>Bold </strong>');
            expect(result.html).toContain('<em>italic</em>');
        });

        it('should handle links', async () => {
            const doc: RichTextDocument = {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{
                        type: 'text',
                        text: 'Click here',
                        marks: [{
                            type: 'link',
                            attrs: { href: 'https://example.com', target: '_blank' }
                        }]
                    }]
                }]
            };

            const result = await transformer.transform(doc, {
                contentType: 'rich-text',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<a href="https://example.com" target="_blank">Click here</a>');
        });

        it('should handle bullet lists', async () => {
            const doc: RichTextDocument = {
                type: 'doc',
                content: [{
                    type: 'bullet_list',
                    content: [
                        { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }] },
                        { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }] }
                    ]
                }]
            };

            const result = await transformer.transform(doc, {
                contentType: 'rich-text',
                fieldPath: 'content'
            });

            expect(result.html).toContain('<ul>');
            expect(result.html).toContain('<li>');
            expect(result.html).toContain('Item 1');
            expect(result.html).toContain('Item 2');
        });

        it('should handle images', async () => {
            const doc: RichTextDocument = {
                type: 'doc',
                content: [{
                    type: 'image',
                    attrs: {
                        src: 'https://example.com/image.jpg',
                        alt: 'Description',
                        width: 800,
                        height: 600
                    }
                }]
            };

            const result = await transformer.transform(doc, {
                contentType: 'rich-text',
                fieldPath: 'content'
            });

            expect(result.html).toContain('src="https://example.com/image.jpg"');
            expect(result.html).toContain('alt="Description"');
            expect(result.html).toContain('width="800"');
        });

        it('should calculate word count', async () => {
            const doc: RichTextDocument = {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'One two three four five' }]
                }]
            };

            const result = await transformer.transform(doc, {
                contentType: 'rich-text',
                fieldPath: 'content'
            });

            expect(result.metadata?.wordCount).toBe(5);
        });
    });

    describe('TransformerPipeline', () => {
        it('should route to correct transformer', async () => {
            const pipeline = new TransformerPipeline();
            pipeline.register(new MarkdownTransformer());

            const result = await pipeline.transform('# Hello', 'markdown');
            expect(result.html).toContain('<h1>Hello</h1>');
        });

        it('should throw error for unknown content type', async () => {
            const pipeline = new TransformerPipeline();

            expect(async () => {
                await pipeline.transform('content', 'unknown');
            }).toThrow();
        });

        it('should use default transformer', async () => {
            const pipeline = new TransformerPipeline();
            const markdownTransformer = new MarkdownTransformer();
            
            pipeline.setDefault(markdownTransformer);

            const result = await pipeline.transform('# Test', 'unknown');
            expect(result.html).toContain('<h1>Test</h1>');
        });
    });

    describe('transformContent helper', () => {
        it('should use global pipeline', async () => {
            // Register transformer in global pipeline first
            const { getPipeline } = await import('../src/transformers/pipeline.js');
            getPipeline().register(new MarkdownTransformer());
            
            const result = await transformContent('# Hello', 'markdown');
            expect(result.html).toBeDefined();
        });
    });
});
