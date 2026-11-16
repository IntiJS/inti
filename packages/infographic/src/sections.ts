/**
 * Each section kind as a tree. Rules that hold across all of them:
 *
 * - Text wears text colours; a coloured mark beside it carries identity.
 * - Categorical colours go in the theme's order and follow the item, never its rank.
 * - Good and bad always ship with an arrow and a sign, never colour alone.
 * - Value labels are selective on dense charts: every number on every point is noise.
 * - Bars start at zero. Lines may not, and say where they start on the axis.
 */

import type { Bound, ComparisonSection, Datum, GaugeSection, HeatmapSection, ItemsSection, Kpi, KpisSection, LineSection, Section, StatSection, StepsSection, TableSection, TextSection, TimelineSection, ValueFormat } from './data.js';
import { formatValue } from './data.js';
import type { InfographicFormat, TypeScale } from './formats.js';
import type { InfographicTheme } from './themes.js';
import { h, type Child, type Style, type VNode } from './vnode.js';

export interface Ctx {
    theme: InfographicTheme;
    t: TypeScale;
    format: InfographicFormat;
    locale: string;
    /** Stroke and mark scale: 1 on a 1080 px wide canvas */
    s: number;
    mode: 'image' | 'web';
}

// ============================================
// Primitives
// ============================================

export function text(value: Bound | string | undefined, style: Style, as?: string): VNode | null {
    if (value === undefined) return null;
    const bound = typeof value === 'string' ? { text: value } : value;
    if (!bound.text) return null;
    return h('div', { style, ...(bound.field ? { field: bound.field } : {}), ...(as ? { as } : {}) }, bound.text);
}

export function hexToRgb(hex: string): [number, number, number] {
    const clean = hex.replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.slice(0, 6);
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `amount` of `a` over `b` */
export function mix(a: string, b: string, amount: number): string {
    const [r1, g1, b1] = hexToRgb(a);
    const [r2, g2, b2] = hexToRgb(b);
    const c = (x: number, y: number) => Math.round(x * amount + y * (1 - amount)).toString(16).padStart(2, '0');
    return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

function luminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark or light ink, whichever reads on that fill */
export function inkOn(fill: string, theme: InfographicTheme): string {
    const light = luminance(theme.text) > 0.5 ? theme.text : '#ffffff';
    const dark = luminance(theme.text) > 0.5 ? '#0b0b0b' : theme.text;
    return luminance(fill) > 0.35 ? dark : light;
}

const seriesColor = (ctx: Ctx, i: number) => ctx.theme.series[i % ctx.theme.series.length];

/** Highlighted items keep the colour; the rest step back */
function itemColor(ctx: Ctx, items: Datum[], item: Datum): string {
    const anyHighlight = items.some((d) => d.highlight);
    if (!anyHighlight) return ctx.theme.series[0];
    return item.highlight ? ctx.theme.series[0] : mix(ctx.theme.muted, ctx.theme.surface, 0.55);
}

function card(ctx: Ctx, children: Child[], style: Style = {}): VNode {
    const { t, theme } = ctx;
    return h(
        'div',
        {
            style: {
                flexDirection: 'column',
                backgroundColor: theme.surface,
                border: `${Math.max(1, Math.round(ctx.s * 1.5))}px solid ${theme.border}`,
                borderRadius: t.radius,
                padding: Math.round(t.gap * 0.8),
                gap: Math.round(t.gap * 0.5),
                ...style
            }
        },
        ...children
    );
}

function sectionHeading(section: Section, ctx: Ctx): Child[] {
    const { t, theme } = ctx;
    return [
        text(section.title, { fontSize: t.heading, fontWeight: 800, color: theme.text, lineHeight: 1.15 }, 'h3'),
        text(section.note, { fontSize: t.small, color: theme.textSecondary, lineHeight: 1.35, marginTop: -Math.round(t.gap * 0.3) }, 'p')
    ];
}

function legend(ctx: Ctx, entries: { label: string; color: string; value?: string }[]): VNode {
    const { t, theme } = ctx;
    const dot = Math.round(t.small * 0.75);
    return h(
        'div',
        { style: { flexWrap: 'wrap', columnGap: Math.round(t.gap * 0.6), rowGap: Math.round(t.gap * 0.25) } },
        ...entries.map((entry) =>
            h(
                'div',
                { style: { alignItems: 'center', gap: Math.round(dot * 0.6) } },
                h('div', { style: { width: dot, height: dot, borderRadius: dot, backgroundColor: entry.color, flexShrink: 0 } }),
                h('div', { style: { fontSize: t.small, color: theme.textSecondary, lineHeight: 1.2 } }, entry.label),
                entry.value ? h('div', { style: { fontSize: t.small, color: theme.text, fontWeight: 600, lineHeight: 1.2 } }, entry.value) : null
            )
        )
    );
}

/** An accessible name for a chart: its numbers in words */
function describe(title: Bound | undefined, pairs: [string, string][]): string {
    const body = pairs.map(([label, value]) => `${label}: ${value}`).join(', ');
    return title?.text ? `${title.text}. ${body}` : body;
}

function chartBox(label: string, style: Style, ...children: Child[]): VNode {
    return h('div', { role: 'img', 'aria-label': label, style }, ...children);
}

/**
 * One notation per chart: "412 mil €" beside "98.000,00 €" reads as two different units.
 * When the largest value calls for compact notation, every value in the section gets it.
 */
function fmt(value: number | null, section: { format: ValueFormat; scaleMax?: number }, ctx: Ctx): string {
    const format = section.format;
    const big = section.scaleMax !== undefined && format.compact === undefined && format.decimals === undefined && Math.abs(section.scaleMax) >= 100_000;
    return formatValue(value, big && (format.format === 'number' || format.format === 'currency' || !format.format) ? { ...format, compact: true } : format, ctx.locale);
}

function triangle(ctx: Ctx, direction: 'up' | 'down' | 'flat', color: string, size: number): VNode {
    const points = direction === 'up' ? '0,10 5,1 10,10' : direction === 'down' ? '0,1 5,10 10,1' : '1,2 9,5.5 1,9';
    return h('svg', { width: size, height: size, viewBox: '0 0 11 11', style: { flexShrink: 0 } }, h('polygon', { points, fill: color }));
}

// ============================================
// SVG geometry
// ============================================

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
    // Angles in radians, 0 at the top, clockwise
    const point = (a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const [x1, y1] = point(from);
    const [x2, y2] = point(to);
    const large = to - from > Math.PI ? 1 : 0;
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Round numbers for an axis that covers [min, max] */
export function niceTicks(min: number, max: number, count = 4): number[] {
    if (min === max) {
        const pad = Math.abs(min) || 1;
        min -= pad;
        max += pad;
    }
    const raw = (max - min) / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? raw;
    const start = Math.floor(min / step) * step;
    const ticks: number[] = [];
    for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
    return ticks;
}

const estimateWidth = (value: string, size: number) => value.length * size * 0.58;

// ============================================
// Sections
// ============================================

function kpiTile(kpi: Kpi, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const pad = Math.round(t.gap * 0.7);
    const inner = width - pad * 2;
    const direction = kpi.delta === null || kpi.delta === 0 ? 'flat' : kpi.delta > 0 ? 'up' : 'down';
    const good = direction === 'flat' ? null : (direction === 'up') === kpi.upIsGood;
    const deltaColor = good === null ? theme.textSecondary : good ? theme.good : theme.bad;
    const sparkHeight = Math.round(t.kpi * 0.55);

    let spark: VNode | null = null;
    if (kpi.trend.length >= 2) {
        const min = Math.min(...kpi.trend);
        const max = Math.max(...kpi.trend);
        const stroke = Math.max(2, 2.5 * ctx.s);
        const y = (v: number) => stroke + (1 - (v - min) / (max - min || 1)) * (sparkHeight - stroke * 2);
        const x = (i: number) => stroke + (i / (kpi.trend.length - 1)) * (inner - stroke * 2);
        const points = kpi.trend.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        const last = kpi.trend.length - 1;
        spark = h(
            'svg',
            { width: inner, height: sparkHeight, viewBox: `0 0 ${inner} ${sparkHeight}`, 'aria-hidden': 'true' },
            h('polyline', { points, fill: 'none', stroke: theme.series[0], 'stroke-width': stroke, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
            h('circle', { cx: x(last), cy: y(kpi.trend[last]), r: stroke * 1.8, fill: theme.series[0], stroke: theme.surface, 'stroke-width': stroke })
        );
    }

    return h(
        'div',
        {
            style: {
                flexDirection: 'column',
                width,
                backgroundColor: theme.surface,
                border: `${Math.max(1, Math.round(ctx.s * 1.5))}px solid ${theme.border}`,
                borderRadius: t.radius,
                padding: pad,
                gap: Math.round(t.gap * 0.25)
            }
        },
        text(kpi.label, { fontSize: t.label, color: theme.textSecondary, lineHeight: 1.25 }),
        h('div', { style: { fontSize: t.kpi, fontWeight: 800, color: theme.text, lineHeight: 1.05, letterSpacing: -1 } }, kpi.display),
        kpi.deltaDisplay
            ? h(
                  'div',
                  { style: { alignItems: 'center', gap: Math.round(t.small * 0.35) } },
                  triangle(ctx, direction, deltaColor, Math.round(t.small * 0.8)),
                  h('div', { style: { fontSize: t.small, fontWeight: 700, color: deltaColor, lineHeight: 1.2 } }, kpi.deltaDisplay)
              )
            : null,
        spark
    );
}

function kpisSection(section: KpisSection, ctx: Ctx, width: number): VNode {
    const { t } = ctx;
    const perRow = ctx.format.columns === 2 && width > ctx.format.width * 0.6 ? Math.min(4, Math.max(1, section.items.length)) : Math.min(2, Math.max(1, section.items.length));
    const tile = Math.floor((width - t.gap * 0.6 * (perRow - 1)) / perRow);
    return h(
        'div',
        { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.5), width } },
        ...sectionHeading(section, ctx),
        h('div', { style: { flexWrap: 'wrap', gap: Math.round(t.gap * 0.6) } }, ...section.items.map((kpi) => kpiTile(kpi, ctx, tile)))
    );
}

function statSection(section: StatSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    return card(ctx, [
        ...sectionHeading(section, ctx),
        h(
            'div',
            { style: { gap: Math.round(t.gap * 0.6), alignItems: 'stretch' } },
            h('div', { style: { width: Math.max(6, Math.round(8 * ctx.s)), borderRadius: 8, backgroundColor: theme.accent, flexShrink: 0 } }),
            h(
                'div',
                { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.2), flexShrink: 1 } },
                h('div', { style: { fontSize: t.hero, fontWeight: 800, color: theme.text, lineHeight: 1, letterSpacing: -3 } }, section.display),
                text(section.label, { fontSize: t.subtitle, fontWeight: 700, color: theme.text, lineHeight: 1.2 }),
                text(section.text, { fontSize: t.body, color: theme.textSecondary, lineHeight: 1.4 }, 'p')
            )
        )
    ], { width });
}

function barSection(section: ItemsSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const values = section.items.map((d) => d.value ?? 0);
    const min = Math.min(0, ...values);
    const max = Math.max(section.scaleMax, ...values, 0);
    const span = max - min || 1;
    const zero = (-min / span) * inner;
    const barHeight = Math.round(t.body * 0.62);

    const rows = section.items.map((item) => {
        const value = item.value ?? 0;
        const length = (Math.abs(value) / span) * inner;
        const left = value >= 0 ? zero : zero - length;
        const color = itemColor(ctx, section.items, item);
        return h(
            'div',
            { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.15) } },
            h(
                'div',
                { style: { justifyContent: 'space-between', alignItems: 'flex-end', gap: t.gap * 0.4 } },
                text(item.label, { fontSize: t.label, color: theme.text, fontWeight: item.highlight ? 700 : 400, lineHeight: 1.25, flexShrink: 1 }),
                h('div', { style: { fontSize: t.label, color: theme.text, fontWeight: 700, lineHeight: 1.25, flexShrink: 0 } }, fmt(item.value, section, ctx))
            ),
            h(
                'div',
                { style: { position: 'relative', width: inner, height: barHeight, backgroundColor: theme.grid, borderRadius: 4 } },
                h('div', {
                    title: `${item.label.text}: ${fmt(item.value, section, ctx)}`,
                    style: {
                        position: 'absolute',
                        left: Math.round(left),
                        top: 0,
                        width: Math.max(item.value ? 3 : 0, Math.round(length)),
                        height: barHeight,
                        backgroundColor: color,
                        borderRadius: value >= 0 ? '0 4px 4px 0' : '4px 0 0 4px'
                    }
                })
            )
        );
    });

    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, section.items.map((d) => [d.label.text, fmt(d.value, section, ctx)])),
            { flexDirection: 'column', gap: Math.round(t.gap * 0.45) },
            ...rows
        )
    ], { width });
}

function columnSection(section: ItemsSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const n = Math.max(1, section.items.length);
    const height = Math.round(Math.min(inner * 0.55, t.body * 14));
    const gap = Math.max(2, Math.round((inner / n) * 0.22));
    const colWidth = Math.max(4, Math.floor((inner - gap * (n - 1)) / n));
    const max = Math.max(section.scaleMax, ...section.items.map((d) => d.value ?? 0), 0) || 1;
    // Past eight columns, label the ones a reader looks for: the highest, the lowest, the last
    const values = section.items.map((d) => d.value ?? -Infinity);
    const keep = new Set<number>();
    if (n <= 8) section.items.forEach((_, i) => keep.add(i));
    else {
        keep.add(values.indexOf(Math.max(...values)));
        keep.add(n - 1);
        section.items.forEach((d, i) => d.highlight && keep.add(i));
    }
    const labelEvery = n <= 8 ? 1 : Math.ceil(n / 6);
    const valueSize = n > 6 ? t.small : t.label;

    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, section.items.map((d) => [d.label.text, fmt(d.value, section, ctx)])),
            { flexDirection: 'column', gap: Math.round(t.gap * 0.25) },
            h(
                'div',
                { style: { alignItems: 'flex-end', gap, height: height + valueSize * 1.4, borderBottom: `${Math.max(1, Math.round(2 * ctx.s))}px solid ${theme.grid}` } },
                ...section.items.map((item, i) =>
                    h(
                        'div',
                        { style: { flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', width: colWidth, gap: Math.round(valueSize * 0.25) } },
                        keep.has(i) ? h('div', { style: { fontSize: valueSize, fontWeight: 700, color: theme.text, lineHeight: 1.1 } }, fmt(item.value, section, ctx)) : null,
                        h('div', {
                            title: `${item.label.text}: ${fmt(item.value, section, ctx)}`,
                            style: {
                                width: colWidth,
                                height: Math.max(item.value ? 3 : 0, Math.round((Math.max(0, item.value ?? 0) / max) * height)),
                                backgroundColor: itemColor(ctx, section.items, item),
                                borderRadius: '4px 4px 0 0'
                            }
                        })
                    )
                )
            ),
            h(
                'div',
                { style: { gap } },
                ...section.items.map((item, i) =>
                    h(
                        'div',
                        { style: { width: colWidth, justifyContent: 'center', fontSize: t.small, color: theme.textSecondary, lineHeight: 1.15, textAlign: 'center' } },
                        i % labelEvery === 0 || i === n - 1 ? (item.label.field ? text(item.label, { fontSize: t.small, color: theme.textSecondary, textAlign: 'center' }) : item.label.text) : ''
                    )
                )
            )
        )
    ], { width });
}

function lineSection(section: LineSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const all = section.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    const area = section.kind === 'area';
    const rawMin = all.length ? Math.min(...all) : 0;
    const rawMax = all.length ? Math.max(...all) : 1;
    // Areas encode magnitude from zero; lines may zoom in and show where they start
    const ticks = niceTicks(area ? Math.min(0, rawMin) : rawMin, rawMax, 4);
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const axisFormat = { ...section.format, format: section.format.format === 'number' && Math.abs(hi) >= 10_000 ? 'compact' : section.format.format } as ValueFormat;
    const tickLabels = ticks.map((v) => formatValue(v, axisFormat, ctx.locale));
    const axisWidth = Math.ceil(Math.max(...tickLabels.map((label) => estimateWidth(label, t.small)))) + Math.round(t.small * 0.6);
    const plotWidth = inner - axisWidth;
    const plotHeight = Math.round(Math.min(inner * (ctx.format.columns === 2 ? 0.28 : 0.5), t.body * 13));
    const stroke = Math.max(2, 3 * ctx.s);
    const n = Math.max(2, section.labels.length);
    const x = (i: number) => stroke * 2 + (i / (n - 1)) * (plotWidth - stroke * 4);
    const y = (v: number) => stroke * 2 + (1 - (v - lo) / (hi - lo || 1)) * (plotHeight - stroke * 4);

    const marks: VNode[] = [];
    ticks.forEach((tick) => marks.push(h('line', { x1: 0, x2: plotWidth, y1: y(tick), y2: y(tick), stroke: theme.grid, 'stroke-width': Math.max(1, ctx.s * 1.5) })));
    section.series.forEach((serie, s) => {
        const color = seriesColor(ctx, s);
        // A missing value breaks the line instead of drawing it at zero
        const segments: [number, number][][] = [[]];
        serie.values.forEach((v, i) => (v === null ? segments.push([]) : segments[segments.length - 1].push([x(i), y(v)])));
        for (const segment of segments.filter((seg) => seg.length)) {
            const points = segment.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
            if (area && section.series.length === 1 && segment.length > 1) {
                const base = y(Math.max(lo, 0));
                marks.push(h('polygon', { points: `${segment[0][0].toFixed(1)},${base} ${points} ${segment[segment.length - 1][0].toFixed(1)},${base}`, fill: color, 'fill-opacity': 0.16 }));
            }
            marks.push(h('polyline', { points, fill: 'none', stroke: color, 'stroke-width': stroke, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        }
        const lastIndex = serie.values.map((v) => v !== null).lastIndexOf(true);
        if (lastIndex >= 0) {
            marks.push(h('circle', { cx: x(lastIndex), cy: y(serie.values[lastIndex] as number), r: stroke * 1.9, fill: color, stroke: theme.surface, 'stroke-width': stroke }));
        }
    });

    const labelEvery = Math.max(1, Math.ceil(section.labels.length / (ctx.format.columns === 2 ? 6 : 5)));
    const xLabels = section.labels
        .map((label, i) => ({ label, i }))
        .filter(({ i }) => i % labelEvery === 0 || i === section.labels.length - 1)
        // The last label is always kept; drop the regular one before it if they would collide
        .filter(({ i }, k, list) => !(k === list.length - 2 && list[list.length - 1].i - i < labelEvery * 0.6));

    const lastValues = section.series.map((serie) => {
        const last = [...serie.values].reverse().find((v) => v !== null) ?? null;
        return fmt(last, section, ctx);
    });
    const single = section.series.length === 1;
    const labelHeight = Math.round(t.small * 1.5);

    return card(ctx, [
        ...sectionHeading(section, ctx),
        single
            ? h(
                  'div',
                  { style: { alignItems: 'baseline', gap: Math.round(t.gap * 0.3) } },
                  h('div', { style: { fontSize: t.kpi * 0.7, fontWeight: 800, color: theme.text, lineHeight: 1 } }, lastValues[0]),
                  h('div', { style: { fontSize: t.small, color: theme.textSecondary } }, section.labels[section.labels.length - 1] ?? '')
              )
            : legend(ctx, section.series.map((serie, s) => ({ label: serie.name, color: seriesColor(ctx, s), value: lastValues[s] }))),
        chartBox(
            describe(section.title, section.series.flatMap((serie) => serie.values.map((v, i) => [`${single ? '' : `${serie.name} `}${section.labels[i]}`, fmt(v, section, ctx)] as [string, string]))),
            { flexDirection: 'column' },
            h(
                'div',
                { style: { width: inner, height: plotHeight } },
                h(
                    'div',
                    { style: { position: 'relative', width: axisWidth, height: plotHeight, flexShrink: 0 } },
                    ...ticks.map((tick, i) =>
                        h(
                            'div',
                            {
                                style: {
                                    position: 'absolute',
                                    right: Math.round(t.small * 0.6),
                                    top: Math.round(y(tick) - t.small * 0.62),
                                    fontSize: t.small,
                                    color: theme.muted,
                                    lineHeight: 1.2
                                }
                            },
                            tickLabels[i]
                        )
                    )
                ),
                h('svg', { width: plotWidth, height: plotHeight, viewBox: `0 0 ${plotWidth} ${plotHeight}`, 'aria-hidden': 'true' }, ...marks)
            ),
            h(
                'div',
                { style: { position: 'relative', width: inner, height: labelHeight, marginTop: Math.round(t.small * 0.3) } },
                ...xLabels.map(({ label, i }) => {
                    const w = estimateWidth(label, t.small) + 4;
                    const center = axisWidth + x(i);
                    const left = Math.max(axisWidth, Math.min(inner - w, center - w / 2));
                    return h('div', { style: { position: 'absolute', left: Math.round(left), top: 0, fontSize: t.small, color: theme.textSecondary, lineHeight: 1.2, whiteSpace: 'nowrap' } }, label);
                })
            )
        )
    ], { width });
}

function donutSection(section: ItemsSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const total = section.items.reduce((sum, d) => sum + Math.max(0, d.value ?? 0), 0) || 1;
    const side = ctx.format.columns === 2 && inner > t.body * 22;
    const size = Math.round(side ? Math.min(inner * 0.45, t.body * 13) : Math.min(inner * 0.62, t.body * 15));
    const thickness = Math.round(size * 0.16);
    const r = size / 2 - thickness / 2;
    const gapAngle = Math.min(0.04, (2 * Math.max(2, 2 * ctx.s)) / r);
    let angle = 0;
    const arcs = section.items.map((item, i) => {
        const sweep = (Math.max(0, item.value ?? 0) / total) * Math.PI * 2;
        const from = angle + (sweep > gapAngle * 2 ? gapAngle / 2 : 0);
        const to = angle + sweep - (sweep > gapAngle * 2 ? gapAngle / 2 : 0);
        angle += sweep;
        if (sweep <= 0) return null;
        // A whole circle cannot be one arc command
        if (sweep >= Math.PI * 2 - 0.001) return h('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: seriesColor(ctx, i), 'stroke-width': thickness });
        return h('path', { d: arcPath(size / 2, size / 2, r, from, to), fill: 'none', stroke: seriesColor(ctx, i), 'stroke-width': thickness });
    });
    const largest = section.items.reduce((best, d, i) => ((d.value ?? 0) > (section.items[best].value ?? 0) ? i : best), 0);
    const pct = (d: Datum) => formatValue(((d.value ?? 0) / total) * 100, { format: 'percent', decimals: 0 }, ctx.locale);

    const chart = h(
        'div',
        { style: { position: 'relative', width: size, height: size, flexShrink: 0, alignItems: 'center', justifyContent: 'center' } },
        h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: { position: 'absolute', left: 0, top: 0 }, 'aria-hidden': 'true' }, ...arcs),
        h(
            'div',
            { style: { flexDirection: 'column', alignItems: 'center', maxWidth: size - thickness * 2.4 } },
            h('div', { style: { fontSize: Math.round(size * 0.17), fontWeight: 800, color: theme.text, lineHeight: 1 } }, section.items[largest] ? pct(section.items[largest]) : '–'),
            h('div', { style: { fontSize: t.small, color: theme.textSecondary, lineHeight: 1.2, textAlign: 'center', justifyContent: 'center' } }, section.items[largest]?.label.text ?? '')
        )
    );

    const legendRows = h(
        'div',
        { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.3), flexGrow: 1, flexShrink: 1 } },
        ...section.items.map((item, i) =>
            h(
                'div',
                { style: { alignItems: 'center', gap: Math.round(t.label * 0.5) } },
                h('div', { style: { width: Math.round(t.label * 0.7), height: Math.round(t.label * 0.7), borderRadius: 4, backgroundColor: seriesColor(ctx, i), flexShrink: 0 } }),
                text(item.label, { fontSize: t.label, color: theme.text, lineHeight: 1.25, flexGrow: 1, flexShrink: 1 }),
                h('div', { style: { fontSize: t.label, fontWeight: 700, color: theme.text, lineHeight: 1.25, flexShrink: 0 } }, pct(item)),
                // The raw value only adds something when the data was not already a percentage
                Math.abs(total - 100) > 0.5 ? h('div', { style: { fontSize: t.small, color: theme.muted, lineHeight: 1.25, flexShrink: 0 } }, fmt(item.value, section, ctx)) : null
            )
        )
    );

    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, section.items.map((d) => [d.label.text, `${pct(d)} (${fmt(d.value, section, ctx)})`])),
            side ? { alignItems: 'center', gap: t.gap } : { flexDirection: 'column', alignItems: 'center', gap: Math.round(t.gap * 0.6) },
            chart,
            side ? legendRows : h('div', { style: { width: inner } }, legendRows)
        )
    ], { width });
}

function shareSection(section: ItemsSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const total = section.items.reduce((sum, d) => sum + Math.max(0, d.value ?? 0), 0) || 1;
    const height = Math.round(t.body * 1.6);
    const gap = Math.max(2, Math.round(2 * ctx.s));
    const pct = (d: Datum) => formatValue(((d.value ?? 0) / total) * 100, { format: 'percent', decimals: 0 }, ctx.locale);
    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, section.items.map((d) => [d.label.text, pct(d)])),
            { flexDirection: 'column', gap: Math.round(t.gap * 0.5) },
            h(
                'div',
                { style: { height, gap, borderRadius: 6, overflow: 'hidden' } },
                ...section.items
                    .filter((d) => (d.value ?? 0) > 0)
                    .map((item) => {
                        const i = section.items.indexOf(item);
                        const share = Math.max(0, item.value ?? 0) / total;
                        const fill = seriesColor(ctx, i);
                        return h(
                            'div',
                            { title: `${item.label.text}: ${pct(item)}`, style: { flexGrow: share, flexBasis: 0, backgroundColor: fill, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } },
                            share > 0.09 ? h('div', { style: { fontSize: t.small, fontWeight: 700, color: inkOn(fill, theme), lineHeight: 1 } }, pct(item)) : null
                        );
                    })
            ),
            legend(ctx, section.items.map((d, i) => ({ label: d.label.text, color: seriesColor(ctx, i), value: pct(d) })))
        )
    ], { width });
}

function waffleSection(section: ItemsSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const sum = section.items.reduce((s, d) => s + Math.max(0, d.value ?? 0), 0);
    // Percentages that add to 100 or less are drawn as given; anything else as shares
    const asPercent = sum <= 100.5 && (section.format.format === 'percent' || sum > 0);
    const counts = section.items.map((d) => Math.round(asPercent && sum <= 100.5 ? Math.max(0, d.value ?? 0) : (Math.max(0, d.value ?? 0) / (sum || 1)) * 100));
    const grid = Math.round(Math.min(inner * (ctx.format.columns === 2 ? 0.5 : 0.7), t.body * 14));
    const gap = Math.max(2, Math.round(grid * 0.012));
    const cell = (grid - gap * 9) / 10;
    const cells: string[] = [];
    counts.forEach((count, i) => cells.push(...Array(count).fill(seriesColor(ctx, i))));
    while (cells.length < 100) cells.push(theme.grid);
    const pct = (i: number) => formatValue(counts[i], { format: 'percent', decimals: 0 }, ctx.locale);

    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, section.items.map((d, i) => [d.label.text, pct(i)])),
            { flexDirection: ctx.format.columns === 2 ? 'row' : 'column', alignItems: 'center', gap: t.gap },
            h(
                'div',
                { style: { flexWrap: 'wrap', width: grid, gap, flexShrink: 0 } },
                ...cells.slice(0, 100).map((color) => h('div', { style: { width: cell, height: cell, borderRadius: Math.max(2, cell * 0.18), backgroundColor: color } }))
            ),
            h(
                'div',
                { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.4), flexShrink: 1 } },
                ...section.items.map((item, i) =>
                    h(
                        'div',
                        { style: { flexDirection: 'column' } },
                        h(
                            'div',
                            { style: { alignItems: 'center', gap: Math.round(t.label * 0.4) } },
                            h('div', { style: { width: Math.round(t.label * 0.7), height: Math.round(t.label * 0.7), borderRadius: 4, backgroundColor: seriesColor(ctx, i) } }),
                            h('div', { style: { fontSize: t.kpi * 0.75, fontWeight: 800, color: theme.text, lineHeight: 1.05 } }, pct(i))
                        ),
                        text(item.label, { fontSize: t.label, color: theme.textSecondary, lineHeight: 1.3 })
                    )
                )
            )
        )
    ], { width });
}

function progressSection(section: ItemsSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const height = Math.round(t.body * 0.55);
    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, section.items.map((d) => [d.label.text, `${fmt(d.value, section, ctx)} / ${fmt(d.max ?? 100, section, ctx)}`])),
            { flexDirection: 'column', gap: Math.round(t.gap * 0.5) },
            ...section.items.map((item) => {
                const max = item.max ?? (section.format.format === 'percent' ? 100 : section.scaleMax || 100);
                const ratio = Math.max(0, Math.min(1, (item.value ?? 0) / (max || 1)));
                const ratioText = formatValue(ratio * 100, { format: 'percent', decimals: 0 }, ctx.locale);
                return h(
                    'div',
                    { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.15) } },
                    h(
                        'div',
                        { style: { justifyContent: 'space-between', alignItems: 'flex-end', gap: t.gap * 0.4 } },
                        text(item.label, { fontSize: t.label, color: theme.text, lineHeight: 1.25, flexShrink: 1 }),
                        h(
                            'div',
                            { style: { gap: Math.round(t.small * 0.5), alignItems: 'baseline', flexShrink: 0 } },
                            h('div', { style: { fontSize: t.label, fontWeight: 700, color: theme.text, lineHeight: 1.25 } }, ratioText),
                            section.format.format === 'percent' ? null : h('div', { style: { fontSize: t.small, color: theme.muted, lineHeight: 1.25 } }, `${fmt(item.value, section, ctx)} / ${fmt(max, section, ctx)}`)
                        )
                    ),
                    h(
                        'div',
                        { style: { width: inner, height, backgroundColor: theme.grid, borderRadius: height } },
                        h('div', { style: { width: Math.round(inner * ratio), height, backgroundColor: ratio >= 1 ? theme.good : theme.series[0], borderRadius: height } })
                    )
                );
            })
        )
    ], { width });
}

function gaugeSection(section: GaugeSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const size = Math.round(Math.min(inner * 0.8, t.body * 16));
    const thickness = Math.round(size * 0.11);
    const r = size / 2 - thickness / 2;
    const height = Math.round(size / 2 + thickness / 2);
    const ratio = Math.max(0, Math.min(1, (section.value ?? 0) / (section.max || 1)));
    const from = -Math.PI / 2;
    const track = arcPath(size / 2, size / 2, r, from, Math.PI / 2);
    const value = ratio > 0.002 ? arcPath(size / 2, size / 2, r, from, from + Math.PI * ratio) : null;
    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, [[section.label?.text ?? '', `${fmt(section.value, section, ctx)} / ${fmt(section.max, section, ctx)}`]]),
            { flexDirection: 'column', alignItems: 'center', gap: Math.round(t.gap * 0.3) },
            h(
                'div',
                { style: { position: 'relative', width: size, height, justifyContent: 'center', alignItems: 'flex-end' } },
                h(
                    'svg',
                    { width: size, height, viewBox: `0 0 ${size} ${height}`, style: { position: 'absolute', left: 0, top: 0 }, 'aria-hidden': 'true' },
                    h('path', { d: track, fill: 'none', stroke: theme.grid, 'stroke-width': thickness, 'stroke-linecap': 'round' }),
                    value ? h('path', { d: value, fill: 'none', stroke: theme.series[0], 'stroke-width': thickness, 'stroke-linecap': 'round' }) : null
                ),
                h('div', { style: { fontSize: Math.round(size * 0.16), fontWeight: 800, color: theme.text, lineHeight: 1 } }, fmt(section.value, section, ctx))
            ),
            h(
                'div',
                { style: { width: size, justifyContent: 'space-between' } },
                h('div', { style: { fontSize: t.small, color: theme.muted } }, fmt(0, section, ctx)),
                text(section.label, { fontSize: t.label, color: theme.textSecondary, textAlign: 'center' }),
                h('div', { style: { fontSize: t.small, color: theme.muted } }, fmt(section.max, section, ctx))
            )
        )
    ], { width });
}

function funnelSection(section: ItemsSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const first = section.items[0]?.value || 1;
    const height = Math.round(t.body * 1.5);
    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, section.items.map((d) => [d.label.text, fmt(d.value, section, ctx)])),
            { flexDirection: 'column', gap: Math.round(t.gap * 0.35) },
            ...section.items.map((item, i) => {
                const ratio = Math.max(0.02, Math.min(1, (item.value ?? 0) / first));
                const previous = i > 0 ? section.items[i - 1].value : null;
                const step = previous ? formatValue(((item.value ?? 0) / previous) * 100, { format: 'percent', decimals: 0 }, ctx.locale) : null;
                const fill = mix(theme.series[0], theme.surface, 1 - i * (0.5 / Math.max(1, section.items.length - 1)));
                return h(
                    'div',
                    { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.12) } },
                    h(
                        'div',
                        { style: { justifyContent: 'space-between', gap: t.gap * 0.4 } },
                        text(item.label, { fontSize: t.label, color: theme.text, lineHeight: 1.25, flexShrink: 1 }),
                        h(
                            'div',
                            { style: { gap: Math.round(t.small * 0.6), alignItems: 'baseline', flexShrink: 0 } },
                            step ? h('div', { style: { fontSize: t.small, color: theme.textSecondary } }, `↓ ${step}`) : null,
                            h('div', { style: { fontSize: t.label, fontWeight: 700, color: theme.text } }, fmt(item.value, section, ctx))
                        )
                    ),
                    h('div', { style: { width: inner, justifyContent: 'center' } }, h('div', { style: { width: Math.round(inner * ratio), height, backgroundColor: fill, borderRadius: 6 } }))
                );
            })
        )
    ], { width });
}

function heatmapSection(section: HeatmapSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const inner = width - Math.round(t.gap * 0.8) * 2;
    const ramp = theme.sequential;
    const labelWidth = Math.round(Math.min(inner * 0.28, Math.max(...section.rows.map((r) => estimateWidth(r.label, t.small)), t.small * 3) + t.small));
    const n = Math.max(1, section.columns.length);
    const gap = Math.max(2, Math.round(2 * ctx.s));
    const cell = Math.floor((inner - labelWidth - gap * (n - 1)) / n);
    const cellHeight = Math.round(Math.min(cell, t.body * 2.2));
    const span = section.max - section.min || 1;
    const step = (v: number) => Math.min(ramp.length - 1, Math.floor(((v - section.min) / span) * ramp.length));
    const showValues = cell >= t.small * 2.6;
    const compact = { ...section.format, format: section.format.format === 'number' ? 'compact' : section.format.format } as ValueFormat;
    return card(ctx, [
        ...sectionHeading(section, ctx),
        chartBox(
            describe(section.title, section.rows.flatMap((row) => row.values.map((v, c) => [`${row.label} ${section.columns[c]}`, fmt(v, section, ctx)] as [string, string]))),
            { flexDirection: 'column', gap },
            h(
                'div',
                { style: { gap } },
                h('div', { style: { width: labelWidth, flexShrink: 0 } }),
                ...section.columns.map((column) => h('div', { style: { width: cell, justifyContent: 'center', fontSize: t.small, color: theme.textSecondary, overflow: 'hidden', whiteSpace: 'nowrap' } }, column))
            ),
            ...section.rows.map((row) =>
                h(
                    'div',
                    { style: { gap, alignItems: 'center' } },
                    h('div', { style: { width: labelWidth, flexShrink: 0, fontSize: t.small, color: theme.text, lineHeight: 1.2 } }, row.label),
                    ...row.values.map((v, c) => {
                        const fill = v === null ? theme.grid : ramp[step(v)];
                        return h(
                            'div',
                            { title: `${row.label} · ${section.columns[c]}: ${fmt(v, section, ctx)}`, style: { width: cell, height: cellHeight, backgroundColor: fill, borderRadius: 4, alignItems: 'center', justifyContent: 'center' } },
                            showValues && v !== null ? h('div', { style: { fontSize: t.small * 0.9, fontWeight: 600, color: inkOn(fill, theme) } }, formatValue(v, compact, ctx.locale)) : null
                        );
                    })
                )
            ),
            h(
                'div',
                { style: { alignItems: 'center', gap: Math.round(t.small * 0.5), marginTop: Math.round(t.gap * 0.3) } },
                h('div', { style: { fontSize: t.small, color: theme.muted } }, fmt(section.min, section, ctx)),
                ...ramp.map((color) => h('div', { style: { width: Math.round(t.small * 1.6), height: Math.round(t.small * 0.8), backgroundColor: color } })),
                h('div', { style: { fontSize: t.small, color: theme.muted } }, fmt(section.max, section, ctx))
            )
        )
    ], { width });
}

function tableSection(section: TableSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const tint = mix(theme.accent, theme.surface, 0.12);
    const flex = (c: number) => (c === 0 ? 1.6 : 1);
    const cellPad = Math.round(t.small * 0.55);
    const cellStyle = (c: number): Style => ({ flexGrow: flex(c), flexBasis: 0, justifyContent: section.numeric[c] && c > 0 ? 'flex-end' : 'flex-start', textAlign: section.numeric[c] && c > 0 ? 'right' : 'left', padding: `${cellPad}px ${Math.round(cellPad * 0.8)}px`, minWidth: 0 });
    const rule = `${Math.max(1, Math.round(1.5 * ctx.s))}px solid ${theme.grid}`;
    return card(ctx, [
        ...sectionHeading(section, ctx),
        h(
            'div',
            { as: 'table', style: { flexDirection: 'column' } },
            section.columns.some(Boolean)
                ? h(
                      'div',
                      { as: 'tr', style: { borderBottom: `${Math.max(2, Math.round(2.5 * ctx.s))}px solid ${theme.border}` } },
                      ...section.columns.map((column, c) => h('div', { as: 'th', style: { ...cellStyle(c), fontSize: t.small, fontWeight: 700, color: theme.textSecondary, lineHeight: 1.2 } }, column))
                  )
                : null,
            ...section.rows.map((row) =>
                h(
                    'div',
                    { as: 'tr', style: { borderBottom: rule, backgroundColor: row.highlight ? tint : undefined } },
                    ...row.cells.map((cell, c) => h('div', { as: 'td', style: { ...cellStyle(c), fontSize: t.label, fontWeight: c === 0 || row.highlight ? 600 : 400, color: theme.text, lineHeight: 1.3 } }, cell))
                )
            )
        )
    ], { width });
}

function comparisonSection(section: ComparisonSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const side = (label: Bound, color: string, align: 'flex-start' | 'flex-end') =>
        h(
            'div',
            { style: { flexGrow: 1, flexBasis: 0, justifyContent: align, alignItems: 'center', gap: Math.round(t.small * 0.5) } },
            h('div', { style: { width: Math.round(t.label * 0.8), height: Math.round(t.label * 0.8), borderRadius: 4, backgroundColor: color } }),
            text(label, { fontSize: t.label, fontWeight: 800, color: theme.text })
        );
    const value = (v: string, better: boolean, align: 'left' | 'right') =>
        h(
            'div',
            { style: { flexGrow: 1, flexBasis: 0, justifyContent: align === 'left' ? 'flex-start' : 'flex-end', alignItems: 'center', gap: Math.round(t.small * 0.4) } },
            better && align === 'right' ? triangle(ctx, 'up', theme.good, Math.round(t.small * 0.75)) : null,
            h('div', { style: { fontSize: t.subtitle, fontWeight: better ? 800 : 500, color: theme.text, lineHeight: 1.15, textAlign: align } }, v),
            better && align === 'left' ? triangle(ctx, 'up', theme.good, Math.round(t.small * 0.75)) : null
        );
    return card(ctx, [
        ...sectionHeading(section, ctx),
        h('div', { style: { justifyContent: 'space-between' } }, side(section.left, theme.series[0], 'flex-start'), side(section.right, theme.series[1], 'flex-end')),
        ...section.rows.map((row) =>
            h(
                'div',
                { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.1), borderTop: `${Math.max(1, Math.round(1.5 * ctx.s))}px solid ${theme.grid}`, paddingTop: Math.round(t.gap * 0.3) } },
                text(row.label, { fontSize: t.small, color: theme.textSecondary, justifyContent: 'center', textAlign: 'center' }),
                h('div', { style: { justifyContent: 'space-between' } }, value(row.left, row.better === 'left', 'left'), value(row.right, row.better === 'right', 'right'))
            )
        )
    ], { width });
}

function timelineSection(section: TimelineSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const dot = Math.round(t.body * 0.6);
    const railWidth = Math.max(2, Math.round(3 * ctx.s));
    return card(ctx, [
        ...sectionHeading(section, ctx),
        h(
            'div',
            { as: 'ol', style: { flexDirection: 'column' } },
            ...section.items.map((item, i) =>
                h(
                    'div',
                    { as: 'li', style: { gap: Math.round(t.gap * 0.5) } },
                    h(
                        'div',
                        { style: { flexDirection: 'column', alignItems: 'center', width: dot, flexShrink: 0 } },
                        h('div', { style: { width: dot, height: dot, borderRadius: dot, backgroundColor: theme.accent, marginTop: Math.round(t.small * 0.2) } }),
                        i < section.items.length - 1 ? h('div', { style: { width: railWidth, flexGrow: 1, backgroundColor: theme.grid } }) : null
                    ),
                    h(
                        'div',
                        { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.1), paddingBottom: i < section.items.length - 1 ? Math.round(t.gap * 0.6) : 0, flexShrink: 1 } },
                        text(item.date, { fontSize: t.small, fontWeight: 700, color: theme.textSecondary, letterSpacing: 0.5 }),
                        text(item.title, { fontSize: t.body, fontWeight: 700, color: theme.text, lineHeight: 1.25 }),
                        text(item.text, { fontSize: t.label, color: theme.textSecondary, lineHeight: 1.4 })
                    )
                )
            )
        )
    ], { width });
}

function stepsSection(section: StepsSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    const badge = Math.round(t.body * 1.6);
    return card(ctx, [
        ...sectionHeading(section, ctx),
        h(
            'div',
            { as: 'ol', style: { flexDirection: 'column', gap: Math.round(t.gap * 0.55) } },
            ...section.items.map((item, i) =>
                h(
                    'div',
                    { as: 'li', style: { gap: Math.round(t.gap * 0.5), alignItems: 'flex-start' } },
                    h('div', { style: { width: badge, height: badge, borderRadius: badge, backgroundColor: theme.accent, color: theme.onAccent, fontSize: Math.round(badge * 0.5), fontWeight: 800, alignItems: 'center', justifyContent: 'center', flexShrink: 0 } }, String(i + 1 + (section.offset ?? 0))),
                    h(
                        'div',
                        { style: { flexDirection: 'column', gap: Math.round(t.gap * 0.1), flexShrink: 1, paddingTop: Math.round((badge - t.body * 1.25) / 2) } },
                        text(item.title, { fontSize: t.body, fontWeight: 700, color: theme.text, lineHeight: 1.25 }),
                        text(item.text, { fontSize: t.label, color: theme.textSecondary, lineHeight: 1.4 })
                    )
                )
            )
        )
    ], { width });
}

function textSection(section: TextSection, ctx: Ctx, width: number): VNode {
    const { t, theme } = ctx;
    if (!section.quote) {
        return card(ctx, [...sectionHeading(section, ctx), text(section.text, { fontSize: t.body, color: theme.text, lineHeight: 1.5 }, 'p')], { width });
    }
    return card(ctx, [
        ...sectionHeading(section, ctx),
        h('div', { style: { fontSize: Math.round(t.title * 1.4), fontWeight: 800, color: theme.accent, lineHeight: 0.8, height: Math.round(t.title * 0.7) } }, '“'),
        text(section.text, { fontSize: t.subtitle, fontWeight: 600, color: theme.text, lineHeight: 1.35 }, 'blockquote'),
        section.author ? text({ ...section.author, text: `— ${section.author.text}` }, { fontSize: t.label, color: theme.textSecondary }) : null
    ], { width });
}

export function renderSection(section: Section, ctx: Ctx, width: number): VNode {
    switch (section.kind) {
        case 'kpis':
            return kpisSection(section, ctx, width);
        case 'stat':
            return statSection(section, ctx, width);
        case 'bar':
            return barSection(section, ctx, width);
        case 'column':
            return columnSection(section, ctx, width);
        case 'line':
        case 'area':
            return lineSection(section, ctx, width);
        case 'donut':
            return donutSection(section, ctx, width);
        case 'share':
            return shareSection(section, ctx, width);
        case 'waffle':
            return waffleSection(section, ctx, width);
        case 'progress':
            return progressSection(section, ctx, width);
        case 'gauge':
            return gaugeSection(section, ctx, width);
        case 'funnel':
            return funnelSection(section, ctx, width);
        case 'heatmap':
            return heatmapSection(section, ctx, width);
        case 'table':
            return tableSection(section, ctx, width);
        case 'comparison':
            return comparisonSection(section, ctx, width);
        case 'timeline':
            return timelineSection(section, ctx, width);
        case 'steps':
            return stepsSection(section, ctx, width);
        case 'text':
            return textSection(section, ctx, width);
    }
}

/** How a section sits on a two-column canvas when the content does not say */
export function defaultSpan(section: Section): 'full' | 'half' {
    if (section.span) return section.span;
    return ['kpis', 'table', 'heatmap', 'line', 'area', 'comparison'].includes(section.kind) ? 'full' : 'half';
}

/** The kinds that can continue on the next image, and how */
export function splitSize(section: Section): number {
    switch (section.kind) {
        case 'kpis':
        case 'bar':
        case 'column':
        case 'progress':
        case 'timeline':
        case 'steps':
            return section.items.length;
        case 'table':
        case 'heatmap':
        case 'comparison':
            return section.rows.length;
        default:
            return 0;
    }
}

export function sliceSection(section: Section, start: number, end: number): Section {
    switch (section.kind) {
        case 'kpis':
            return { ...section, items: section.items.slice(start, end) };
        case 'bar':
        case 'column':
        case 'progress':
            return { ...section, items: section.items.slice(start, end) };
        case 'timeline':
            return { ...section, items: section.items.slice(start, end) };
        case 'steps':
            return { ...section, items: section.items.slice(start, end), offset: (section.offset ?? 0) + start };
        case 'table':
            return { ...section, rows: section.rows.slice(start, end) };
        case 'heatmap':
            return { ...section, rows: section.rows.slice(start, end) };
        case 'comparison':
            return { ...section, rows: section.rows.slice(start, end) };
        default:
            return section;
    }
}
