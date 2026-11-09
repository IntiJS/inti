/**
 * The vocabulary: the blocks a model can compose with.
 *
 * It is the same rule that governs the human editor. The model picks ready-made
 * components and fills in their fields: it writes no HTML, CSS or code, and it
 * cannot name a type or a field that is not here.
 */

interface FieldBase {
    description?: string;
}

/** Plain text. The component prints it escaped */
export interface TextField extends FieldBase {
    type: 'string' | 'text';
    maxLength?: number;
}

/** HTML from a closed set of tags; it is rebuilt during validation */
export interface RichTextField extends FieldBase {
    type: 'richtext';
    maxLength?: number;
}

export interface NumberField extends FieldBase {
    type: 'number';
    min?: number;
    max?: number;
}

export interface BooleanField extends FieldBase {
    type: 'boolean';
}

/** A link. Only the allowed schemes get through */
export interface UrlField extends FieldBase {
    type: 'url';
    /** Default: http, https, mailto, tel. Relative paths are always valid */
    schemes?: string[];
}

export interface ListField extends FieldBase {
    type: 'list';
    of: GeneratorField;
    maxItems?: number;
}

export interface ObjectField extends FieldBase {
    type: 'object';
    fields: Record<string, GeneratorField>;
}

/**
 * A reference to something that already exists in a data source. The model only
 * picks an id: the server supplies the value, so a price or an image cannot come
 * from the model.
 *
 * - `media` and `relation` are stored in the CMS as an id.
 * - `data` only makes sense at render time: it is what `fromData` produces.
 */
export interface ReferenceField extends FieldBase {
    type: 'media' | 'relation' | 'data';
    source: string;
    /** A list of references instead of a single one */
    multiple?: boolean;
    max?: number;
}

export type GeneratorField =
    | TextField
    | RichTextField
    | NumberField
    | BooleanField
    | UrlField
    | ListField
    | ObjectField
    | ReferenceField;

export interface VocabularyBlock {
    /** Identifier in the CMS: acf_fc_layout, Strapi uid, Kitsuden type */
    nativeType: string;
    label?: string;
    description?: string;
    /** When this block is a good fit. It reaches the model as a rule */
    when?: string;
    /** Without fields it can only be inserted empty */
    fields?: Record<string, GeneratorField>;
    variants?: Record<string, string[]>;
}

export type Vocabulary = VocabularyBlock[];

/** Declares the vocabulary as a `native type → definition` map */
export function defineVocabulary(blocks: Record<string, Omit<VocabularyBlock, 'nativeType'>>): Vocabulary {
    return Object.entries(blocks).map(([nativeType, block]) => ({ nativeType, ...block }));
}

/** `products: fromData('products', { max: 6 })`: the model picks ids, never prices */
export function fromData(source: string, options: { multiple?: boolean; max?: number; description?: string } = {}): ReferenceField {
    return { type: 'data', source, multiple: options.multiple ?? true, ...options };
}

// ============================================
// Data sources
// ============================================

/** Something the model can pick */
export interface DataItem {
    id: string | number;
    /** The only thing the model sees. It is content, not instructions */
    summary: string;
    /** What the component receives when rendering. It never reaches the model */
    value?: unknown;
}

/** A fixed list or a search based on the request */
export type DataSource = DataItem[] | ((prompt: string) => Promise<DataItem[]> | DataItem[]);

export type DataSources = Record<string, DataSource>;

/** The sources a vocabulary uses */
export function sourcesUsed(vocabulary: Vocabulary): Set<string> {
    const found = new Set<string>();

    const visit = (field: GeneratorField): void => {
        if (field.type === 'list') visit(field.of);
        else if (field.type === 'object') Object.values(field.fields).forEach(visit);
        else if (field.type === 'media' || field.type === 'relation' || field.type === 'data') found.add(field.source);
    };

    for (const block of vocabulary) Object.values(block.fields ?? {}).forEach(visit);
    return found;
}
