/**
 * Checks the output against the vocabulary.
 *
 * It runs even though the schema already guarantees it: a custom provider may not
 * honor it, and here the consequence of accepting garbage is writing broken blocks
 * into the customer's CMS or painting something nobody approved onto the page.
 * Whatever does not fit is dropped, and that is reported.
 */

import { isDangerousText, safeUrl, sanitizeRichText } from './sanitize.js';
import type { Candidates } from './schema.js';
import type { GeneratorField, Vocabulary, VocabularyBlock } from './vocabulary.js';

export interface GeneratedBlock {
    nativeType: string;
    data: Record<string, unknown>;
}

export interface ValidationResult {
    /** What is saved: references are ids */
    blocks: GeneratedBlock[];
    /** What is rendered: references are their real values */
    rendered: GeneratedBlock[];
    warnings: string[];
}

/** Dropped value: `undefined` is a legitimate result for absent `JSON` */
const DROP = Symbol('drop');

interface FieldResult {
    stored: unknown;
    rendered: unknown;
}

function checkField(
    value: unknown,
    field: GeneratorField,
    path: string,
    candidates: Candidates,
    warnings: string[]
): FieldResult | typeof DROP {
    const same = (result: unknown): FieldResult => ({ stored: result, rendered: result });
    const reject = (reason: string): typeof DROP => {
        warnings.push(`Discarded ${path}: ${reason}.`);
        return DROP;
    };

    switch (field.type) {
        case 'string':
        case 'text': {
            if (typeof value !== 'string') return reject('expected text');
            if (isDangerousText(value)) return reject('executable URL scheme');
            if (field.maxLength && value.length > field.maxLength) {
                warnings.push(`Truncated ${path} to ${field.maxLength} characters.`);
                return same(value.slice(0, field.maxLength));
            }
            return same(value);
        }
        case 'richtext': {
            if (typeof value !== 'string') return reject('expected text');
            const clean = sanitizeRichText(value);
            if (field.maxLength && clean.length > field.maxLength) return reject(`longer than ${field.maxLength} characters`);
            return same(clean);
        }
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value)) return reject('expected a number');
            if (field.min !== undefined && value < field.min) return reject(`below ${field.min}`);
            if (field.max !== undefined && value > field.max) return reject(`above ${field.max}`);
            return same(value);
        }
        case 'boolean':
            return typeof value === 'boolean' ? same(value) : reject('expected true or false');
        case 'url': {
            const url = safeUrl(value, field.schemes);
            return url === null ? reject('URL not allowed') : same(url);
        }
        case 'list': {
            if (!Array.isArray(value)) return reject('expected a list');
            const items = field.maxItems ? value.slice(0, field.maxItems) : value;
            if (items.length < value.length) warnings.push(`Truncated ${path} to ${field.maxItems} items.`);

            const stored: unknown[] = [];
            const rendered: unknown[] = [];
            items.forEach((item, index) => {
                const result = checkField(item, field.of, `${path}.${index}`, candidates, warnings);
                if (result === DROP) return;
                stored.push(result.stored);
                rendered.push(result.rendered);
            });
            return { stored, rendered };
        }
        case 'object':
            if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject('expected an object');
            return checkFields(value as Record<string, unknown>, field.fields, undefined, path, candidates, warnings);
        case 'media':
        case 'relation':
        case 'data': {
            const pool = candidates[field.source];
            const resolveOne = (id: unknown, at: string): FieldResult | typeof DROP => {
                if (typeof id !== 'string' && typeof id !== 'number') {
                    warnings.push(`Discarded ${at}: expected an id.`);
                    return DROP;
                }
                // Without candidates there is nothing to check against: nothing
                // the model invents can be taken as valid
                const item = pool?.find((candidate) => String(candidate.id) === String(id));
                if (!item) {
                    warnings.push(`Discarded ${at}: "${id}" is not in "${field.source}".`);
                    return DROP;
                }
                return { stored: item.id, rendered: item.value ?? item.id };
            };

            if (!field.multiple) return resolveOne(value, path);
            if (!Array.isArray(value)) return reject('expected a list of ids');

            const ids = field.max ? value.slice(0, field.max) : value;
            if (ids.length < value.length) warnings.push(`Truncated ${path} to ${field.max} items.`);

            const stored: unknown[] = [];
            const rendered: unknown[] = [];
            ids.forEach((id, index) => {
                const result = resolveOne(id, `${path}.${index}`);
                if (result === DROP) return;
                stored.push(result.stored);
                rendered.push(result.rendered);
            });
            return { stored, rendered };
        }
    }
}

function checkFields(
    value: Record<string, unknown>,
    fields: Record<string, GeneratorField> | undefined,
    variants: Record<string, string[]> | undefined,
    path: string,
    candidates: Candidates,
    warnings: string[]
): { stored: Record<string, unknown>; rendered: Record<string, unknown> } {
    const stored: Record<string, unknown> = {};
    const rendered: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(value)) {
        // Checked against own keys only: `__proto__` or `constructor` are not fields
        const variantValues = variants && Object.hasOwn(variants, key) ? variants[key] : undefined;
        if (variantValues) {
            if (variantValues.includes(String(raw))) {
                stored[key] = raw;
                rendered[key] = raw;
            } else {
                warnings.push(
                    `Discarded invalid variant "${raw}" for "${path}.${key}" (allowed: ${variantValues.join(', ')}).`
                );
            }
            continue;
        }

        const field = fields && Object.hasOwn(fields, key) ? fields[key] : undefined;
        if (!field) {
            warnings.push(`Discarded unknown field "${key}" on "${path}".`);
            continue;
        }

        const result = checkField(raw, field, `${path}.${key}`, candidates, warnings);
        if (result === DROP) continue;
        stored[key] = result.stored;
        rendered[key] = result.rendered;
    }

    return { stored, rendered };
}

/** A block, or null if it cannot be accepted. This is what streaming applies to each one */
export function validateBlock(
    entry: unknown,
    types: Vocabulary,
    candidates: Candidates,
    warnings: string[]
): { block: GeneratedBlock; rendered: GeneratedBlock } | null {
    const nativeType = (entry as any)?.nativeType;
    const declared: VocabularyBlock | undefined =
        typeof nativeType === 'string' ? types.find((type) => type.nativeType === nativeType) : undefined;

    if (!declared) {
        // The case the schema should prevent. It is dropped and reported.
        warnings.push(`Discarded block of unknown type "${nativeType}".`);
        return null;
    }

    const raw = (entry as any)?.data;
    const { stored, rendered } = checkFields(
        raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {},
        declared.fields,
        declared.variants,
        nativeType,
        candidates,
        warnings
    );

    return { block: { nativeType, data: stored }, rendered: { nativeType, data: rendered } };
}

export function validateGenerated(
    raw: unknown,
    types: Vocabulary,
    options: { max?: number; candidates?: Candidates } = {}
): ValidationResult {
    const result: ValidationResult = { blocks: [], rendered: [], warnings: [] };

    const list = (raw as any)?.blocks;
    if (!Array.isArray(list)) {
        result.warnings.push('The model returned no blocks.');
        return result;
    }

    const max = options.max ?? 12;

    for (const entry of list) {
        if (result.blocks.length >= max) {
            result.warnings.push(`Stopped at ${max} blocks; the model proposed ${list.length}.`);
            break;
        }

        const checked = validateBlock(entry, types, options.candidates ?? {}, result.warnings);
        if (checked) {
            result.blocks.push(checked.block);
            result.rendered.push(checked.rendered);
        }
    }

    return result;
}
