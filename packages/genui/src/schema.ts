/**
 * Compiles the vocabulary to JSON Schema.
 *
 * Each type is a variant with `nativeType` pinned by `const` and each reference
 * an `enum` of the available ids, so the output cannot name a block that does not
 * exist or a product that is not on the list.
 *
 * Length and count limits do not go here: structured-output providers do not
 * support all of those keywords. They are applied during validation.
 */

import type { DataItem, GeneratorField, Vocabulary, VocabularyBlock } from './vocabulary.js';

export type Candidates = Record<string, DataItem[]>;

function fieldSchema(field: GeneratorField, candidates: Candidates): Record<string, unknown> {
    const describe = (schema: Record<string, unknown>) =>
        field.description ? { ...schema, description: field.description } : schema;

    switch (field.type) {
        case 'number':
            return describe({ type: 'number' });
        case 'boolean':
            return describe({ type: 'boolean' });
        case 'list':
            return describe({ type: 'array', items: fieldSchema(field.of, candidates) });
        case 'object':
            return describe(objectSchema(field.fields, undefined, candidates));
        case 'media':
        case 'relation':
        case 'data': {
            const ids = (candidates[field.source] ?? []).map((item) => String(item.id));
            const id = ids.length > 0 ? { type: 'string', enum: ids } : { type: 'string' };
            return describe(field.multiple ? { type: 'array', items: id } : id);
        }
        default:
            return describe({ type: 'string' });
    }
}

function objectSchema(
    fields: Record<string, GeneratorField> | undefined,
    variants: Record<string, string[]> | undefined,
    candidates: Candidates
): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [name, field] of Object.entries(fields ?? {})) {
        properties[name] = fieldSchema(field, candidates);
        required.push(name);
    }

    // Variants are a closed set: they are expressed as an enum so that the
    // model cannot invent one the component does not know how to render
    for (const [name, values] of Object.entries(variants ?? {})) {
        if (values.length === 0) continue;
        properties[name] = { type: 'string', enum: values };
        if (!required.includes(name)) required.push(name);
    }

    return { type: 'object', properties, required, additionalProperties: false };
}

export function buildBlockSchema(types: Vocabulary, candidates: Candidates = {}): Record<string, unknown> {
    if (types.length === 0) {
        throw new Error('buildBlockSchema: at least one block type is required.');
    }

    const variants = types.map((type: VocabularyBlock) => ({
        type: 'object',
        properties: {
            nativeType: { const: type.nativeType },
            data: objectSchema(type.fields, type.variants, candidates)
        },
        required: ['nativeType', 'data'],
        additionalProperties: false
    }));

    return {
        type: 'object',
        properties: {
            blocks: {
                type: 'array',
                // With a single type, a one-element anyOf is noise
                items: variants.length === 1 ? variants[0] : { anyOf: variants }
            }
        },
        required: ['blocks'],
        additionalProperties: false
    };
}
