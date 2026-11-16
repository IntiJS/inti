/**
 * From whatever the CMS stores to typed sections.
 *
 * A CMS rarely stores numbers the way a chart wants them: WordPress returns "1.234,5"
 * as a string, an editor pastes a table from a spreadsheet, a data source resolves to
 * an array of objects. Everything here is lenient on input and strict on output: a
 * value that is not a number becomes `null` and is drawn as missing, never as zero.
 */

export const SECTION_KINDS = [
    'kpis',
    'stat',
    'bar',
    'column',
    'line',
    'area',
    'donut',
    'share',
    'waffle',
    'progress',
    'gauge',
    'funnel',
    'heatmap',
    'table',
    'comparison',
    'timeline',
    'steps',
    'text'
] as const;

export type SectionKind = (typeof SECTION_KINDS)[number];

export type NumberStyle = 'number' | 'compact' | 'percent' | 'currency' | 'decimal';

export interface ValueFormat {
    format?: NumberStyle;
    /** ISO 4217, for `currency` */
    currency?: string;
    decimals?: number;
    prefix?: string;
    /** Unit after the number: "km", "h", "pts" */
    suffix?: string;
    /** Force or forbid compact notation ("1,3 M"). Default: compact from 100 000 for currency */
    compact?: boolean;
}

/** What the CMS stores for one infographic block. Every field is optional except sections */
export interface InfographicInput extends ValueFormat {
    eyebrow?: string;
    title?: string;
    subtitle?: string;
    /** Where the numbers come from. Shown on every image */
    source?: string;
    /** "Nov 2026", "Q3": when the data is from */
    date?: string;
    footnote?: string;
    brand?: string;
    /** A data: URI, or a URL from an origin allowed with `imageOrigins` */
    logo?: string;
    /** A theme name the developer declared */
    theme?: string;
    locale?: string;
    sections?: unknown[];
    [field: string]: unknown;
}

/** A text and the CMS field it came from, so the editor can bind it */
export interface Bound {
    text: string;
    field?: string;
}

export interface Datum {
    label: Bound;
    value: number | null;
    highlight: boolean;
    /** For progress and gauges */
    max?: number | null;
    note?: Bound;
}

export interface Kpi {
    label: Bound;
    value: number | null;
    /** Already formatted, or the raw text when the value was not a number ("N/A", "24/7") */
    display: string;
    delta: number | null;
    deltaDisplay: string;
    /** Whether up is good: revenue yes, churn no */
    upIsGood: boolean;
    trend: number[];
}

interface SectionBase {
    kind: SectionKind;
    /** Position in `sections`, for field paths */
    index: number;
    title?: Bound;
    note?: Bound;
    span?: 'full' | 'half';
    format: Required<Pick<ValueFormat, 'format'>> & ValueFormat;
}

export interface KpisSection extends SectionBase { kind: 'kpis'; items: Kpi[] }
export interface StatSection extends SectionBase { kind: 'stat'; value: number | null; display: string; label?: Bound; text?: Bound }
export interface ItemsSection extends SectionBase {
    kind: 'bar' | 'column' | 'donut' | 'share' | 'waffle' | 'progress' | 'funnel';
    items: Datum[];
    /** Shared scale across the pages a long chart is split into */
    scaleMax: number;
}
export interface GaugeSection extends SectionBase { kind: 'gauge'; value: number | null; max: number; label?: Bound }
export interface LineSection extends SectionBase {
    kind: 'line' | 'area';
    labels: string[];
    series: { name: string; values: (number | null)[] }[];
}
export interface HeatmapSection extends SectionBase {
    kind: 'heatmap';
    columns: string[];
    rows: { label: string; values: (number | null)[] }[];
    min: number;
    max: number;
}
export interface TableSection extends SectionBase {
    kind: 'table';
    columns: string[];
    rows: { cells: string[]; highlight: boolean }[];
    numeric: boolean[];
}
export interface ComparisonSection extends SectionBase {
    kind: 'comparison';
    left: Bound;
    right: Bound;
    rows: { label: Bound; left: string; right: string; better: 'left' | 'right' | null }[];
}
export interface TimelineSection extends SectionBase { kind: 'timeline'; items: { date: Bound; title: Bound; text?: Bound }[] }
export interface StepsSection extends SectionBase { kind: 'steps'; items: { title: Bound; text?: Bound }[]; /** Numbering continues across images */ offset?: number }
export interface TextSection extends SectionBase { kind: 'text'; text: Bound; quote: boolean; author?: Bound }

export type Section =
    | KpisSection
    | StatSection
    | ItemsSection
    | GaugeSection
    | LineSection
    | HeatmapSection
    | TableSection
    | ComparisonSection
    | TimelineSection
    | StepsSection
    | TextSection;

export interface Infographic {
    eyebrow?: Bound;
    title?: Bound;
    subtitle?: Bound;
    source?: Bound;
    date?: Bound;
    footnote?: Bound;
    brand?: Bound;
    logo?: string;
    theme?: string;
    locale: string;
    sections: Section[];
}

// ============================================
// Numbers
// ============================================

/** "1.234,5", "1,234.5", "45 %", "$ 1 200", 12 → number. Anything else → null */
export function parseNumber(input: unknown): number | null {
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input !== 'string') return null;

    let text = input.trim().replace(/[\s  ]/g, '');
    if (!text) return null;
    const negative = /^-|^\(.*\)$|^−/.test(text);
    text = text.replace(/[^0-9.,]/g, '');
    if (!/\d/.test(text)) return null;

    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
        // Both: whichever comes last is the decimal separator
        const decimal = lastComma > lastDot ? ',' : '.';
        const thousands = decimal === ',' ? '.' : ',';
        text = text.split(thousands).join('').replace(decimal, '.');
    } else if (lastComma >= 0 || lastDot >= 0) {
        const separator = lastComma >= 0 ? ',' : '.';
        const parts = text.split(separator);
        // "1,234" and "1.234.567" are thousands; "12,5" and "0.75" are decimals
        const thousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0] !== '0' && parts[0] !== '');
        text = thousands ? parts.join('') : parts.join('.');
    }

    const value = Number(text);
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
    const key = `${locale}|${JSON.stringify(options)}`;
    let cached = formatterCache.get(key);
    if (!cached) {
        try {
            cached = new Intl.NumberFormat(locale, options);
        } catch {
            cached = new Intl.NumberFormat('en', { ...options, currency: options.style === 'currency' ? options.currency ?? 'USD' : undefined });
        }
        formatterCache.set(key, cached);
    }
    return cached;
}

/** A number as a reader expects it in that locale. Percent takes 45 for 45 % */
export function formatValue(value: number | null, format: ValueFormat, locale: string): string {
    if (value === null) return '–';
    const decimals = format.decimals;
    const digits = decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    let text: string;
    switch (format.format) {
        case 'compact':
            text = formatter(locale, { notation: 'compact', maximumFractionDigits: decimals ?? 1 }).format(value);
            break;
        case 'percent':
            text = formatter(locale, { style: 'percent', maximumFractionDigits: decimals ?? 1, ...digits }).format(value / 100);
            break;
        case 'currency':
            text = formatter(locale, {
                style: 'currency',
                currency: (format.currency ?? 'USD').toUpperCase(),
                ...((format.compact ?? Math.abs(value) >= 100_000)
                    ? { notation: 'compact', maximumFractionDigits: decimals ?? 1 }
                    : decimals === undefined && Math.abs(value) >= 1000
                      ? { maximumFractionDigits: 0 }
                      : digits)
            }).format(value);
            break;
        case 'decimal':
            text = formatter(locale, { maximumFractionDigits: decimals ?? 2, ...digits }).format(value);
            break;
        default:
            if (format.compact) {
                text = formatter(locale, { notation: 'compact', maximumFractionDigits: decimals ?? 1 }).format(value);
                break;
            }
            text = formatter(locale, { maximumFractionDigits: decimals ?? (Math.abs(value) < 10 ? 1 : 0), ...digits }).format(value);
    }
    return `${format.prefix ?? ''}${text}${format.suffix ? `${/^[%°]/.test(format.suffix) ? '' : ' '}${format.suffix}` : ''}`;
}

/** +12,5 % with a real minus sign */
export function formatDelta(value: number | null, format: ValueFormat, locale: string): string {
    if (value === null) return '';
    const body = formatValue(Math.abs(value), format, locale);
    return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${body}`;
}

// ============================================
// Tables pasted as text
// ============================================

/**
 * A table typed or pasted into a text field: one row per line, cells separated by
 * tab, semicolon or comma (in that order of preference, so "12,5" survives with ";").
 */
export function parseDelimited(text: string): string[][] {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return [];
    const sample = lines.slice(0, 5).join('\n');
    const separator = sample.includes('\t') ? '\t' : sample.includes(';') ? ';' : sample.includes('|') ? '|' : ',';
    return lines.map((line) => splitLine(line, separator).map((cell) => cell.trim()));
}

function splitLine(line: string, separator: string): string[] {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (quoted && line[i + 1] === '"') {
                current += '"';
                i++;
            } else quoted = !quoted;
        } else if (char === separator && !quoted) {
            cells.push(current);
            current = '';
        } else current += char;
    }
    cells.push(current);
    return cells;
}

/** Rows of cells from text, an array of arrays or an array of objects */
export function toRows(input: unknown): { header: string[] | null; rows: unknown[][] } {
    const value = unwrap(input);
    if (typeof value === 'string') {
        const rows = parseDelimited(value);
        if (!rows.length) return { header: null, rows: [] };
        // A first row with no number past its label column is a header
        const first = rows[0];
        const isHeader = first.length > 1 && first.slice(1).every((cell) => parseNumber(cell) === null);
        return isHeader ? { header: first, rows: rows.slice(1) } : { header: null, rows };
    }
    if (!Array.isArray(value)) return { header: null, rows: [] };
    if (value.every((row) => Array.isArray(row))) return { header: null, rows: value as unknown[][] };

    const objects = value.filter((row): row is Record<string, unknown> => isRecord(row));
    const keys = [...new Set(objects.flatMap((row) => Object.keys(row)))];
    return { header: keys, rows: objects.map((row) => keys.map((key) => row[key])) };
}

/** A data source can resolve to `{ value: [...] }`, `{ rows }`, `{ items }` or the array itself */
function unwrap(input: unknown): unknown {
    let value = input;
    for (let i = 0; i < 3 && isRecord(value); i++) {
        const next = value.items ?? value.rows ?? value.data ?? value.value ?? value.points;
        if (next === undefined) break;
        value = next;
    }
    return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    if (typeof value === 'string') return value.trim() || undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function bound(value: unknown, field: string | undefined): Bound | undefined {
    const text = str(value);
    if (text === undefined) return undefined;
    // Only a string can be written back as typed: a number edited as text would change type
    return { text, field: typeof value === 'string' ? field : undefined };
}

function bool(value: unknown): boolean {
    return value === true || value === 1 || value === 'true' || value === '1' || value === 'yes' || value === 'sí' || value === 'si';
}

function series(input: unknown): number[] {
    if (typeof input === 'string') return input.split(/[\s,;|]+/).map(parseNumber).filter((n): n is number => n !== null);
    if (Array.isArray(input)) return input.map(parseNumber).filter((n): n is number => n !== null);
    return [];
}

// ============================================
// Normalization
// ============================================

const pick = (record: Record<string, unknown>, ...names: string[]) => {
    for (const name of names) if (record[name] !== undefined && record[name] !== null && record[name] !== '') return { name, value: record[name] };
    return { name: names[0], value: undefined };
};

function valueFormat(record: Record<string, unknown>, inherited: ValueFormat): SectionBase['format'] {
    const format = str(record.format) as NumberStyle | undefined;
    const valid: NumberStyle[] = ['number', 'compact', 'percent', 'currency', 'decimal'];
    const decimals = parseNumber(record.decimals);
    return {
        format: format && valid.includes(format) ? format : inherited.format ?? 'number',
        currency: str(record.currency) ?? inherited.currency,
        decimals: decimals !== null ? Math.max(0, Math.min(6, Math.round(decimals))) : inherited.decimals,
        prefix: str(record.prefix) ?? inherited.prefix,
        suffix: str(record.suffix) ?? str(record.unit) ?? inherited.suffix
    };
}

/** Datums from `items` (bindable) or from `data` (a table or a resolved data source) */
function datums(record: Record<string, unknown>, path: string): Datum[] {
    if (Array.isArray(record.items) && record.items.length) {
        return record.items.filter(isRecord).map((item, j) => {
            const label = pick(item, 'label', 'name', 'title');
            const value = pick(item, 'value', 'amount', 'count', 'y');
            const note = pick(item, 'note', 'description');
            return {
                label: bound(label.value, `${path}.items.${j}.${label.name}`) ?? { text: '' },
                value: parseNumber(value.value),
                highlight: bool(item.highlight),
                max: parseNumber(item.max ?? item.target ?? item.goal),
                note: bound(note.value, `${path}.items.${j}.${note.name}`)
            };
        });
    }

    const { header, rows } = toRows(record.data ?? record.dataset);
    const lower = header?.map((h) => h.toLowerCase()) ?? [];
    const col = (names: string[], fallback: number) => {
        const found = lower.findIndex((h) => names.includes(h));
        return found >= 0 ? found : fallback;
    };
    const labelAt = col(['label', 'name', 'title', 'category'], 0);
    const valueAt = col(['value', 'amount', 'count', 'y'], labelAt === 0 ? 1 : 0);
    const maxAt = col(['max', 'target', 'goal'], -1);
    const highlightAt = col(['highlight'], -1);
    return rows.map((row) => ({
        label: { text: str(row[labelAt]) ?? '' },
        value: parseNumber(row[valueAt]),
        highlight: highlightAt >= 0 && bool(row[highlightAt]),
        max: maxAt >= 0 ? parseNumber(row[maxAt]) : null
    }));
}

function kpis(record: Record<string, unknown>, path: string, format: SectionBase['format'], locale: string): Kpi[] {
    const source: Record<string, unknown>[] = Array.isArray(record.items)
        ? record.items.filter(isRecord)
        : (() => {
              const { header, rows } = toRows(record.data);
              const keys = header?.map((h) => h.toLowerCase()) ?? ['label', 'value', 'delta', 'trend'];
              return rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]])));
          })();
    const fromItems = Array.isArray(record.items);

    return source.map((item, j) => {
        const own = valueFormat(item, format);
        const raw = item.value;
        const value = parseNumber(raw);
        const delta = parseNumber(item.delta ?? item.change);
        const deltaFormat: ValueFormat = { format: (str(item.deltaFormat) as NumberStyle) ?? 'percent', decimals: own.decimals };
        const label = pick(item, 'label', 'name', 'title');
        return {
            label: bound(label.value, fromItems ? `${path}.items.${j}.${label.name}` : undefined) ?? { text: '' },
            value,
            // "24/7" or "N/A" is shown as written rather than as a dash
            display: value === null ? str(raw) ?? '–' : formatValue(value, own, locale),
            delta,
            deltaDisplay: formatDelta(delta, deltaFormat, locale),
            upIsGood: !(str(item.goodWhen) === 'down' || bool(item.inverse)),
            trend: series(item.trend ?? item.sparkline)
        };
    });
}

function normalizeSection(input: unknown, index: number, inherited: ValueFormat, locale: string, warnings: string[]): Section | null {
    if (!isRecord(input)) return null;
    const path = `sections.${index}`;
    const kind = (str(input.kind) ?? str(input.type) ?? '').toLowerCase() as SectionKind;
    if (!SECTION_KINDS.includes(kind)) {
        warnings.push(`Section ${index} skipped: unknown kind "${String(input.kind ?? input.type)}".`);
        return null;
    }
    const span: 'full' | 'half' | undefined = input.span === 'full' || input.span === 'half' ? input.span : undefined;
    const base = {
        index,
        title: bound(input.title, `${path}.title`),
        note: bound(input.note, `${path}.note`),
        span,
        format: valueFormat(input, inherited)
    };

    switch (kind) {
        case 'kpis':
            return { ...base, kind, items: kpis(input, path, base.format, locale) };
        case 'stat': {
            const value = parseNumber(input.value ?? firstValue(input.data));
            return {
                ...base,
                kind,
                value,
                display: value === null ? str(input.value) ?? '–' : formatValue(value, base.format, locale),
                label: bound(input.label, `${path}.label`),
                text: bound(input.text, `${path}.text`)
            };
        }
        case 'bar':
        case 'column':
        case 'donut':
        case 'share':
        case 'waffle':
        case 'progress':
        case 'funnel': {
            let items = datums(input, path);
            if (kind === 'bar' && bool(input.sort)) items = [...items].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
            if (kind === 'donut' || kind === 'share' || kind === 'waffle') items = foldOther(items, kind === 'waffle' ? 3 : 6, str(input.otherLabel) ?? otherLabel(locale));
            const values = items.map((item) => item.value ?? 0);
            const max = parseNumber(input.max);
            return { ...base, kind, items, scaleMax: max ?? Math.max(0, ...values) };
        }
        case 'gauge': {
            const value = parseNumber(input.value ?? firstValue(input.data));
            return { ...base, kind, value, max: parseNumber(input.max) ?? (base.format.format === 'percent' ? 100 : Math.max(value ?? 0, 1)), label: bound(input.label, `${path}.label`) };
        }
        case 'line':
        case 'area': {
            const { header, rows } = toRows(input.data ?? input.items);
            const labels = rows.map((row) => str(row[0]) ?? '');
            const names = header ? header.slice(1) : rows[0]?.slice(1).map((_, i) => `${i + 1}`) ?? [];
            const lineSeries = names.slice(0, 4).map((name, s) => ({ name, values: rows.map((row) => parseNumber(row[s + 1])) }));
            if (names.length > 4) warnings.push(`Section ${index}: only the first 4 series are drawn; more lines than that cannot be told apart.`);
            return { ...base, kind, labels, series: lineSeries };
        }
        case 'heatmap': {
            const { header, rows } = toRows(input.data);
            const columns = header ? header.slice(1) : rows[0]?.slice(1).map((_, i) => String(i + 1)) ?? [];
            const parsed = rows.map((row) => ({ label: str(row[0]) ?? '', values: columns.map((_, c) => parseNumber(row[c + 1])) }));
            const all = parsed.flatMap((row) => row.values).filter((v): v is number => v !== null);
            return { ...base, kind, columns, rows: parsed, min: Math.min(...all, Infinity) === Infinity ? 0 : Math.min(...all), max: all.length ? Math.max(...all) : 1 };
        }
        case 'table': {
            const { header, rows } = toRows(input.data ?? input.rows);
            const columns = (Array.isArray(input.columns) ? input.columns.map((c) => str(c) ?? '') : header) ?? [];
            const cells = rows.map((row) => row.map((cell) => str(cell) ?? ''));
            const width = Math.max(columns.length, ...cells.map((row) => row.length));
            const highlight = new Set(series(input.highlightRows).map((n) => n - 1));
            const numeric = Array.from({ length: width }, (_, c) => cells.length > 0 && cells.every((row) => !row[c] || parseNumber(row[c]) !== null));
            return {
                ...base,
                kind,
                columns: Array.from({ length: width }, (_, c) => columns[c] ?? ''),
                rows: cells.map((row, r) => ({ cells: Array.from({ length: width }, (_, c) => row[c] ?? ''), highlight: highlight.has(r) })),
                numeric
            };
        }
        case 'comparison': {
            const rows = Array.isArray(input.items)
                ? input.items.filter(isRecord).map((item, j) => ({
                      label: bound(item.label, `${path}.items.${j}.label`) ?? { text: '' },
                      left: str(item.left) ?? '',
                      right: str(item.right) ?? '',
                      better: item.better === 'left' || item.better === 'right' ? (item.better as 'left' | 'right') : null
                  }))
                : toRows(input.data).rows.map((row) => ({ label: { text: str(row[0]) ?? '' }, left: str(row[1]) ?? '', right: str(row[2]) ?? '', better: null as 'left' | 'right' | null }));
            return {
                ...base,
                kind,
                left: bound(input.left ?? input.leftLabel, `${path}.left`) ?? { text: 'A' },
                right: bound(input.right ?? input.rightLabel, `${path}.right`) ?? { text: 'B' },
                rows
            };
        }
        case 'timeline':
            return {
                ...base,
                kind,
                items: (Array.isArray(input.items) ? input.items : []).filter(isRecord).map((item, j) => ({
                    date: bound(item.date ?? item.label, `${path}.items.${j}.${item.date !== undefined ? 'date' : 'label'}`) ?? { text: '' },
                    title: bound(item.title, `${path}.items.${j}.title`) ?? { text: '' },
                    text: bound(item.text, `${path}.items.${j}.text`)
                }))
            };
        case 'steps':
            return {
                ...base,
                kind,
                items: (Array.isArray(input.items) ? input.items : []).filter(isRecord).map((item, j) => ({
                    title: bound(item.title ?? item.label, `${path}.items.${j}.${item.title !== undefined ? 'title' : 'label'}`) ?? { text: '' },
                    text: bound(item.text, `${path}.items.${j}.text`)
                }))
            };
        case 'text':
            return {
                ...base,
                kind,
                text: bound(input.text ?? input.body, `${path}.${input.text !== undefined ? 'text' : 'body'}`) ?? { text: '' },
                quote: bool(input.quote),
                author: bound(input.author, `${path}.author`)
            };
    }
}

/** The first number of a table: a stat or a gauge fed from a data source */
function firstValue(input: unknown): unknown {
    const { rows } = toRows(input);
    const row = rows[0];
    if (!row) return undefined;
    return row.length > 1 ? row[1] : row[0];
}

/** Past `limit` slices nobody can tell apart: the smallest fold into one */
function foldOther(items: Datum[], limit: number, label: string): Datum[] {
    if (items.length <= limit) return items;
    const sorted = [...items].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const kept = sorted.slice(0, limit - 1);
    const rest = sorted.slice(limit - 1).reduce((sum, item) => sum + (item.value ?? 0), 0);
    // Keep the editor's order for the ones that stay
    return [...items.filter((item) => kept.includes(item)), { label: { text: label }, value: rest, highlight: false }];
}

const OTHER: Record<string, string> = { es: 'Otros', en: 'Other', pt: 'Outros', fr: 'Autres', de: 'Andere', it: 'Altri' };
function otherLabel(locale: string): string {
    return OTHER[locale.slice(0, 2)] ?? OTHER.en;
}

export function normalizeInfographic(input: unknown, options: { locale?: string } = {}): { infographic: Infographic; warnings: string[] } {
    const warnings: string[] = [];
    const record = isRecord(input) ? input : {};
    const locale = str(record.locale) ?? options.locale ?? 'en';
    const inherited = valueFormat(record, { format: 'number' });
    const rawSections = Array.isArray(record.sections) ? record.sections : [];
    const sections = rawSections
        .map((section, i) => normalizeSection(section, i, inherited, locale, warnings))
        .filter((section): section is Section => section !== null);

    if (!rawSections.length) warnings.push('The infographic has no sections.');

    return {
        infographic: {
            eyebrow: bound(record.eyebrow, 'eyebrow'),
            title: bound(record.title, 'title'),
            subtitle: bound(record.subtitle, 'subtitle'),
            source: bound(record.source, 'source'),
            date: bound(record.date, 'date'),
            footnote: bound(record.footnote, 'footnote'),
            brand: bound(record.brand, 'brand'),
            logo: str(record.logo),
            theme: str(record.theme),
            locale,
            sections
        },
        warnings
    };
}
