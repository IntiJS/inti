/**
 * Workers AI as a `@intijs/genui` provider: the model runs in your Cloudflare
 * account, with no external key.
 *
 * Workers AI's JSON mode does not support streaming, so this provider does not implement
 * `stream`: the proposal arrives all at once. Nor does it guarantee that the output matches
 * the schema, but `@intijs/genui` always validates it, so anything that does not fit is discarded.
 */

export interface WorkersAiConfig {
    /** Default: @cf/meta/llama-3.3-70b-instruct-fp8-fast. Must support JSON mode */
    model?: string;
    maxTokens?: number;
}

interface GenerateRequest {
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
}

export const WORKERS_AI_DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export function createWorkersAiProvider(ai: Ai, config: WorkersAiConfig = {}) {
    const model = config.model ?? WORKERS_AI_DEFAULT_MODEL;

    return {
        async generate({ system, prompt, schema }: GenerateRequest): Promise<unknown> {
            const output = (await ai.run(model as keyof AiModels, {
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: prompt }
                ],
                max_tokens: config.maxTokens ?? 4096,
                response_format: { type: 'json_schema', json_schema: schema }
            } as never)) as { response?: unknown };

            const response = output?.response;
            if (response && typeof response === 'object') return response;
            if (typeof response === 'string') {
                try {
                    return JSON.parse(response);
                } catch {
                    throw new Error('Workers AI returned malformed JSON.');
                }
            }
            throw new Error('Workers AI returned no response.');
        }
    };
}
