/**
 * Prepares values read from the ACF REST API so they can be saved again.
 *
 * ACF does not return what it accepts. Inside a Flexible Content, an image or
 * a relation is read as a full object even when `acf_format=light` is requested,
 * an empty field is read as `false`, and on save the REST schema requires an id or
 * `null`. Since saving a field means resending the whole array, a single image
 * on the page made WordPress reject any edit with a 400.
 *
 * The decision is made with the schema WordPress itself publishes (`OPTIONS` on the
 * post) and not by the shape of the value: a repeater row with `id` and
 * `url` fields looks like an image, but is not one.
 */

export interface RestSchema {
    type?: string | string[];
    properties?: Record<string, RestSchema>;
    items?: RestSchema;
    oneOf?: RestSchema[];
    pattern?: string;
    minItems?: number;
    [key: string]: unknown;
}

function typesOf(schema: RestSchema): string[] {
    if (!schema.type) return [];
    return Array.isArray(schema.type) ? schema.type : [schema.type];
}

const isObject = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

/** The id of what ACF expands: an attachment (`ID`, `id`) or a post (`ID`) */
function idOf(value: Record<string, any>): number | undefined {
    const id = value.ID ?? value.id;
    return typeof id === 'number' ? id : undefined;
}

/** The Flexible Content layout a row belongs to */
function layoutSchema(row: Record<string, any>, variants: RestSchema[]): RestSchema | undefined {
    const layout = row.acf_fc_layout;
    return variants.find((variant) => {
        const pattern = variant.properties?.acf_fc_layout?.pattern;
        return typeof pattern === 'string' && pattern === `^${layout}$`;
    });
}

export function normalizeForWrite(value: any, schema: RestSchema | undefined): any {
    if (!schema) return value;

    if (schema.oneOf) {
        return isObject(value) ? normalizeForWrite(value, layoutSchema(value, schema.oneOf)) : value;
    }

    const types = typesOf(schema);
    if (types.length === 0) return value;

    const acceptsNull = types.includes('null');

    // An empty field is read as `false` or `''`, which its type does not always allow
    if ((value === false && !types.includes('boolean')) || (value === '' && !types.includes('string'))) {
        return acceptsNull ? null : value;
    }

    if (isObject(value)) {
        if (types.includes('object') && schema.properties) {
            const result: Record<string, any> = {};
            for (const [key, child] of Object.entries(value)) {
                result[key] = normalizeForWrite(child, schema.properties[key]);
            }
            return result;
        }
        if (!types.includes('object') && (types.includes('integer') || types.includes('number'))) {
            return idOf(value) ?? (acceptsNull ? null : value);
        }
        return value;
    }

    if (Array.isArray(value) && types.includes('array')) {
        const items = value.map((item) => normalizeForWrite(item, schema.items));
        return items.length === 0 && (schema.minItems ?? 0) > 0 && acceptsNull ? null : items;
    }

    return value;
}

/**
 * Normalizes a post's `acf` object. Whatever the schema does not declare is omitted:
 * it is not a saveable field (SCF adds `<field>_source` to the response) and
 * resending it can only cause a rejection.
 */
export function normalizeAcfForWrite(acf: Record<string, any>, schema: RestSchema | undefined): Record<string, any> {
    if (!schema?.properties) return acf;

    const result: Record<string, any> = {};
    for (const [key, child] of Object.entries(schema.properties)) {
        if (key in acf) result[key] = normalizeForWrite(acf[key], child);
    }
    return result;
}
