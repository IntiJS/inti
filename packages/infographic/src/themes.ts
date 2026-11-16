/**
 * Themes are declared by the developer; editors and the model only pick one by name.
 * There is no way to pass a colour through the content, by design.
 *
 * The series order is the colour-blind safety mechanism (adjacent series stay apart
 * for the common colour-vision deficiencies), so it is fixed, never cycled or
 * reordered by rank. Status colours are reserved for good/bad and always ship with
 * an arrow and a sign, never colour alone.
 */

export interface InfographicTheme {
    name: string;
    /** Canvas */
    background: string;
    /** Cards that hold each section */
    surface: string;
    border: string;
    text: string;
    textSecondary: string;
    muted: string;
    /** Grid lines and empty tracks */
    grid: string;
    accent: string;
    /** Text on an `accent` fill */
    onAccent: string;
    /** Categorical, in this order. A ninth category folds into "Other" */
    series: string[];
    /** One hue, light to dark, for magnitude (heatmaps) */
    sequential: string[];
    good: string;
    bad: string;
    /** Font name as registered with the renderer, and the CSS stack for the web */
    fontFamily: string;
    fontStack: string;
}

const LIGHT_SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const DARK_SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
const BLUE_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const BLUE_RAMP_DARK = ['#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#6da7ec', '#9ec5f4'];

const FONT = { fontFamily: 'Inter', fontStack: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" };

export const THEMES: Record<string, InfographicTheme> = {
    light: {
        name: 'light',
        background: '#f4f3ef',
        surface: '#fcfcfb',
        border: '#e4e2dc',
        text: '#0b0b0b',
        textSecondary: '#52514e',
        muted: '#7a7974',
        grid: '#e4e2dc',
        accent: '#2a78d6',
        onAccent: '#ffffff',
        series: LIGHT_SERIES,
        sequential: BLUE_RAMP,
        good: '#006300',
        bad: '#d03b3b',
        ...FONT
    },
    dark: {
        name: 'dark',
        background: '#111110',
        surface: '#1a1a19',
        border: '#2c2c2a',
        text: '#f0efec',
        textSecondary: '#c3c2b7',
        muted: '#9a998f',
        grid: '#33332f',
        accent: '#3987e5',
        onAccent: '#ffffff',
        series: DARK_SERIES,
        sequential: BLUE_RAMP_DARK,
        good: '#0ca30c',
        bad: '#e66767',
        ...FONT
    },
    /** Inti's own: warm paper and a sun accent */
    sun: {
        name: 'sun',
        background: '#fbf3e4',
        surface: '#fffdf8',
        border: '#ecdcc0',
        text: '#1d1408',
        textSecondary: '#5c4a32',
        muted: '#86735a',
        grid: '#efe2cc',
        accent: '#c2410c',
        onAccent: '#ffffff',
        series: LIGHT_SERIES,
        sequential: BLUE_RAMP,
        good: '#006300',
        bad: '#d03b3b',
        ...FONT
    }
};

/** A theme of your own on top of an existing one: brand colours, another font */
export function defineTheme(base: string | InfographicTheme, overrides: Partial<InfographicTheme> & { name: string }): InfographicTheme {
    const from = typeof base === 'string' ? THEMES[base] : base;
    if (!from) throw new Error(`Unknown base theme "${String(base)}"`);
    return { ...from, ...overrides };
}

export function resolveTheme(name: unknown, custom: InfographicTheme[] = [], fallback = 'light'): InfographicTheme {
    const wanted = typeof name === 'string' ? name : fallback;
    return custom.find((theme) => theme.name === wanted) ?? THEMES[wanted] ?? custom.find((t) => t.name === fallback) ?? THEMES[fallback] ?? THEMES.light;
}
