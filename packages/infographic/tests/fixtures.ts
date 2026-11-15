import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { FontInput } from '../src/render.js';

const require = createRequire(import.meta.url);
const file = (weight: number) => require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`);

/** Inter from @fontsource: no network in tests */
export const fonts: FontInput[] = ([400, 600, 800] as const).map((weight) => ({ name: 'Inter', data: readFileSync(file(weight)), weight, style: 'normal' }));

/** Every section kind, with data shaped the way a CMS stores it */
export const dashboard = {
    eyebrow: 'Quarterly report',
    title: 'Mobile sales doubled in a year',
    subtitle: 'Online store, Q3 2026 against the same quarter of 2025.',
    source: 'Internal analytics',
    date: 'Oct 2026',
    brand: 'Acme',
    locale: 'en',
    sections: [
        {
            kind: 'kpis',
            items: [
                { label: 'Revenue', value: '1,284,500', format: 'currency', currency: 'EUR', delta: 18.4, trend: '12 14 13 17 19 22' },
                { label: 'Orders', value: 23140, delta: 9.1, trend: [8, 9, 9, 10, 11, 12] },
                { label: 'Conversion', value: '3.2', format: 'percent', delta: 0.4, deltaFormat: 'number', trend: '2.6 2.7 2.9 3.0 3.1 3.2' },
                { label: 'Returns', value: 4.1, format: 'percent', delta: 1.2, goodWhen: 'down' }
            ]
        },
        {
            kind: 'line',
            title: 'Mobile overtook desktop in March',
            format: 'compact',
            data: 'Month;Mobile;Desktop\nJan;120000;180000\nFeb;140000;175000\nMar;185000;170000\nApr;210000;168000\nMay;232000;160000\nJun;251000;158000\nJul;268000;150000\nAug;281000;149000\nSep;302000;151000'
        },
        {
            kind: 'bar',
            title: 'Madrid brings in a third of sales',
            format: 'currency',
            currency: 'EUR',
            items: [
                { label: 'Madrid', value: 412000, highlight: true },
                { label: 'Barcelona', value: 298000 },
                { label: 'Valencia', value: 151000 },
                { label: 'Seville', value: 122000 },
                { label: 'Bilbao', value: 98000 }
            ]
        },
        { kind: 'donut', title: 'Acquisition channels', data: 'Channel;Value\nOrganic;42\nPaid;27\nEmail;14\nSocial;11\nOther;6' },
        { kind: 'stat', value: 68, format: 'percent', label: 'of orders come from mobile', text: 'A year earlier it was 41%.' },
        {
            kind: 'progress',
            title: 'Quarterly goals',
            items: [
                { label: 'Revenue', value: 1284500, max: 1200000 },
                { label: 'New customers', value: 6800, max: 9000 },
                { label: 'NPS', value: 41, max: 50 }
            ]
        },
        {
            kind: 'heatmap',
            title: 'Orders by day and time',
            data: 'Day;Morning;Afternoon;Evening\nMon;120;340;410\nTue;130;320;390\nWed;125;360;420\nThu;140;380;470\nFri;160;420;520\nSat;210;480;610\nSun;230;510;580'
        },
        {
            kind: 'table',
            title: 'Best sellers',
            data: 'Product;Units;Revenue\nRun sneakers;3,420;€239,400\nUrban backpack;2,180;€98,100\nTech T-shirt;1,940;€52,380\nSun cap;1,200;€18,000',
            highlightRows: '1'
        },
        {
            kind: 'funnel',
            title: 'From ad to purchase',
            items: [
                { label: 'Visits', value: 720000 },
                { label: 'Product pages', value: 310000 },
                { label: 'Cart', value: 61000 },
                { label: 'Purchase', value: 23140 }
            ]
        },
        { kind: 'waffle', title: 'Returning customers', items: [{ label: 'Return', value: 37 }] },
        { kind: 'gauge', title: 'Satisfaction', value: 4.4, max: 5, format: 'decimal', decimals: 1, label: 'out of 5' },
        {
            kind: 'comparison',
            title: 'Mobile against desktop',
            leftLabel: 'Mobile',
            rightLabel: 'Desktop',
            items: [
                { label: 'Average order', left: '€48', right: '€71', better: 'right' },
                { label: 'Conversion', left: '3.6%', right: '2.4%', better: 'left' },
                { label: 'Time on site', left: '4 min', right: '7 min' }
            ]
        },
        {
            kind: 'timeline',
            title: 'What changed',
            items: [
                { date: 'Feb 2026', title: 'New app', text: 'One-tap checkout with Apple Pay and Google Pay.' },
                { date: 'Apr 2026', title: 'Free shipping from €30', text: 'The average mobile order rose 12%.' },
                { date: 'Jul 2026', title: 'TikTok campaign' }
            ]
        },
        { kind: 'share', title: 'Orders by device', items: [{ label: 'Mobile', value: 68 }, { label: 'Desktop', value: 27 }, { label: 'Tablet', value: 5 }] },
        { kind: 'steps', title: 'How we did it', items: [{ title: 'Measure', text: 'One dashboard with the same numbers for everyone.' }, { title: 'Simplify checkout' }, { title: 'Invest where it converts' }] },
        { kind: 'column', title: 'Orders per month (thousands)', data: 'Jan;8\nFeb;9\nMar;9\nApr;10\nMay;11\nJun;12' },
        { kind: 'text', quote: true, text: 'Customers did not choose mobile: they stopped having a reason to wait for a computer.', author: 'Head of e-commerce' }
    ]
};
