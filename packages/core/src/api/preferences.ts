/**
 * POST /api/inti/preferences
 *
 * Stores what the visitor chose in a cookie of their own. Receives a regular
 * form: `pref.<key>=<value>`, `consent=1` and `next`, where to go back to.
 *
 * Withdrawing consent also deletes what was observed: to stop using it but keep
 * storing it would not be withdrawing it.
 */

import type { APIRoute } from 'astro';
import { CONSENT_COOKIE, PREFERENCES_COOKIE, SEEN_COOKIE, VISITOR_COOKIE } from '../adapt/index.js';

export const prerender = false;

const MAX_KEYS = 20;

/** Only paths on this site: `//other.com` and `/\other.com` lead elsewhere */
function safeNext(value: FormDataEntryValue | null): string {
    return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
}

export const POST: APIRoute = async ({ request, cookies, url, redirect }) => {
    const type = request.headers.get('content-type') ?? '';
    if (!/multipart\/form-data|application\/x-www-form-urlencoded/.test(type)) {
        return new Response('Expected a form', { status: 415 });
    }

    const form = await request.formData();
    const preferences: Record<string, string> = {};

    for (const [name, value] of (form as unknown as Iterable<[string, FormDataEntryValue]>)) {
        if (Object.keys(preferences).length >= MAX_KEYS) break;
        const key = name.startsWith('pref.') ? name.slice(5) : '';
        if (/^[a-zA-Z0-9_-]{1,32}$/.test(key) && typeof value === 'string' && value && value.length <= 64) {
            preferences[key] = value;
        }
    }

    const options = {
        path: '/',
        sameSite: 'lax' as const,
        httpOnly: true,
        secure: url.protocol === 'https:',
        maxAge: 60 * 60 * 24 * 180
    };

    if (Object.keys(preferences).length > 0) {
        cookies.set(PREFERENCES_COOKIE, JSON.stringify(preferences), options);
    } else {
        cookies.delete(PREFERENCES_COOKIE, { path: '/' });
    }

    if (form.get('consent') === '1') {
        cookies.set(CONSENT_COOKIE, '1', options);
    } else {
        cookies.delete(CONSENT_COOKIE, { path: '/' });
        cookies.delete(SEEN_COOKIE, { path: '/' });
        cookies.delete(VISITOR_COOKIE, { path: '/' });
    }

    return redirect(safeNext(form.get('next')), 303);
};
