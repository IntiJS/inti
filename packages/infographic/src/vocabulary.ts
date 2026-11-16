/**
 * The infographic as a block a model can compose with `@intijs/genui`.
 *
 * The model picks section kinds, writes titles and labels, and chooses a declared
 * theme. With `datasets`, every number comes from a data source by id: the value
 * fields are removed, so a figure cannot come from the model.
 */

import type { GeneratorField, VocabularyBlock } from '@intijs/genui';
import { SECTION_KINDS, type SectionKind } from './data.js';
import { THEMES } from './themes.js';

const KIND_HELP: Record<SectionKind, string> = {
    kpis: 'headline numbers as tiles, with change and a small trend',
    stat: 'one big number with a sentence',
    bar: 'compare or rank categories (horizontal bars)',
    column: 'a value over a few periods (vertical columns)',
    line: 'a trend over time, up to 4 series (data as a table)',
    area: 'a single total over time (data as a table)',
    donut: 'parts of a whole, up to 6',
    share: 'parts of a whole as one 100% bar',
    waffle: 'one to three percentages as a 10×10 grid',
    progress: 'progress towards goals',
    gauge: 'one value against its maximum',
    funnel: 'steps that lose people along the way',
    heatmap: 'a value across two dimensions (data as a table)',
    table: 'exact figures in rows and columns (data as a table)',
    comparison: 'two options side by side, row by row',
    timeline: 'dated events in order',
    steps: 'a numbered process',
    text: 'a paragraph or, with quote, a quotation'
};

export interface InfographicVocabularyOptions {
    /** The CMS identifier of the block. Default: `infographic` */
    nativeType?: string;
    label?: string;
    /** Section kinds the model may use. Default: all */
    kinds?: SectionKind[];
    /**
     * A data source (`sources` in createBlockGenerator) whose items resolve to tables:
     * numbers then come only from it, by id
     */
    datasets?: string;
    /** Theme names the model may choose. Default: the built-in ones */
    themes?: string[];
    maxSections?: number;
}

export function infographicVocabulary(options: InfographicVocabularyOptions = {}): VocabularyBlock {
    const kinds = options.kinds ?? [...SECTION_KINDS];
    const fromData = Boolean(options.datasets);
    const data: GeneratorField = fromData
        ? { type: 'data', source: options.datasets!, multiple: false, description: 'The table this section draws. Every number comes from here' }
        : { type: 'text', maxLength: 2000, description: 'A table, one row per line, cells separated by ";". First row: column names. First column: labels' };

    const item: Record<string, GeneratorField> = {
        label: { type: 'string', maxLength: 60 },
        highlight: { type: 'boolean', description: 'Draw attention to this one; the rest step back' },
        title: { type: 'string', maxLength: 80, description: 'timeline and steps' },
        text: { type: 'text', maxLength: 220, description: 'timeline and steps' },
        date: { type: 'string', maxLength: 30, description: 'timeline' },
        ...(fromData
            ? {}
            : {
                  value: { type: 'number' },
                  delta: { type: 'number', description: 'kpis: change, as a percentage' },
                  max: { type: 'number', description: 'progress: the goal' },
                  left: { type: 'string', maxLength: 40, description: 'comparison: value for the left option' },
                  right: { type: 'string', maxLength: 40, description: 'comparison: value for the right option' }
              }),
        goodWhen: { type: 'string', maxLength: 4, description: 'kpis: "up" or "down", whichever direction is good' }
    };

    const section: Record<string, GeneratorField> = {
        kind: { type: 'string', maxLength: 12, description: `One of: ${kinds.map((k) => `${k} (${KIND_HELP[k]})`).join('; ')}` },
        title: { type: 'string', maxLength: 80, description: 'States the finding, not the topic: "Mobile doubled in a year", not "Mobile"' },
        note: { type: 'string', maxLength: 160 },
        format: { type: 'string', maxLength: 10, description: 'number, compact, percent (45 means 45%), currency or decimal' },
        currency: { type: 'string', maxLength: 3 },
        suffix: { type: 'string', maxLength: 12, description: 'Unit after the number: km, h, pts' },
        items: { type: 'list', of: { type: 'object', fields: item }, maxItems: 12 },
        data,
        text: { type: 'text', maxLength: 400, description: 'text and stat' },
        quote: { type: 'boolean' },
        author: { type: 'string', maxLength: 80 },
        label: { type: 'string', maxLength: 60, description: 'stat and gauge' },
        ...(fromData ? {} : { value: { type: 'number', description: 'stat and gauge' } }),
        leftLabel: { type: 'string', maxLength: 40, description: 'comparison: name of the left option' },
        rightLabel: { type: 'string', maxLength: 40, description: 'comparison: name of the right option' }
    };

    return {
        nativeType: options.nativeType ?? 'infographic',
        label: options.label ?? 'Infographic',
        description: 'A data infographic or dashboard: headline numbers, charts, tables, timelines. Rendered on the page and as images for Instagram, TikTok and the blog.',
        when: fromData
            ? 'The request is about numbers, a comparison, a trend or a process. Use only tables from the data; never write a figure yourself.'
            : 'The request is about numbers, a comparison, a trend or a process, and the numbers are given in the request. Never invent a figure.',
        fields: {
            eyebrow: { type: 'string', maxLength: 40 },
            title: { type: 'string', maxLength: 90, description: 'The main finding in a few words' },
            subtitle: { type: 'text', maxLength: 200 },
            source: { type: 'string', maxLength: 120, description: 'Where the numbers come from. Required whenever there are numbers' },
            date: { type: 'string', maxLength: 40, description: 'When the data is from' },
            footnote: { type: 'string', maxLength: 200 },
            sections: { type: 'list', of: { type: 'object', fields: section }, maxItems: options.maxSections ?? 8 }
        },
        variants: { theme: options.themes ?? Object.keys(THEMES) }
    };
}
