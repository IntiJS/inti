/**
 * Provider on top of the Anthropic API.
 *
 * It has its own entry point and the SDK is imported dynamically so that it is an
 * optional dependency: whoever brings their own provider does not install it.
 */

import type { AiProvider, GenerateRequest } from './compose.js';

export interface AnthropicProviderConfig {
    /** The customer's key. Server only: it must never reach the browser */
    apiKey: string;
    /** Default: claude-opus-5-5 */
    model?: string;
    /** Reasoning depth. Composing blocks needs little */
    effort?: 'low' | 'medium' | 'high';
    maxTokens?: number;
}

export function createAnthropicProvider(config: AnthropicProviderConfig): AiProvider {
    if (!config.apiKey) {
        throw new Error('createAnthropicProvider: apiKey is required (bring your own key).');
    }

    const params = ({ system, prompt, schema }: GenerateRequest) => ({
        model: config.model ?? 'claude-opus-5-5',
        max_tokens: config.maxTokens ?? 16000,
        system,
        messages: [{ role: 'user', content: prompt }],
        // If the model declines because of its safety filters, the API retries with
        // another one instead of leaving the generation without an answer
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
            // Composing blocks from a closed vocabulary does not
            // need deep reasoning
            effort: config.effort ?? 'low',
            format: { type: 'json_schema', schema }
        }
    });

    const client = async () => {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        return new Anthropic({ apiKey: config.apiKey });
    };

    return {
        async generate(request) {
            const response: any = await (await client()).beta.messages.create(params(request) as any);

            if (response.stop_reason === 'refusal') {
                throw new Error('The model declined to generate content for this prompt.');
            }

            const text = response.content.find((block: any) => block.type === 'text');
            if (!text || typeof text.text !== 'string') {
                throw new Error('The model returned no text content.');
            }

            try {
                return JSON.parse(text.text);
            } catch {
                throw new Error('The model returned malformed JSON.');
            }
        },

        async *stream(request) {
            const stream: any = (await client()).beta.messages.stream(params(request) as any);

            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                    yield event.delta.text as string;
                }
            }

            const final = await stream.finalMessage();
            if (final.stop_reason === 'refusal') {
                throw new Error('The model declined to generate content for this prompt.');
            }
        }
    };
}
