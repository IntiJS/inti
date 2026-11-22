// Opens a page, double-clicks the first editable field and checks it enters edit mode.
// Presses Escape, which restores the text and writes nothing to the CMS.
//
//   BASE_URL=http://localhost:4330 PAGE_PATH=/ node edit-field.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:4330';
const path = process.env.PAGE_PATH ?? '/';
const out = join(tmpdir(), 'inti-webtest');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
    await page.goto(new URL(path, baseUrl).href, { waitUntil: 'networkidle' });

    const field = page.locator('[data-inti-field]:not([data-inti-relation])').first();
    if ((await field.count()) === 0) {
        throw new Error('No [data-inti-field] on the page: the editor is not rendered (not an editor session?)');
    }

    const name = await field.getAttribute('data-inti-field');
    const before = await field.textContent();

    await field.dblclick();
    const editable = await field.evaluate((el) => el.contentEditable);
    if (editable !== 'plaintext-only' && editable !== 'true') {
        throw new Error(`Double-click did not make "${name}" editable (contentEditable=${editable})`);
    }
    await page.screenshot({ path: join(out, 'editing.png') });

    await page.keyboard.press('Escape');
    const after = await field.textContent();
    if (after !== before) throw new Error(`Escape did not restore "${name}"`);

    console.log(`OK: "${name}" entered edit mode and Escape restored it. Screenshot: ${join(out, 'editing.png')}`);
} catch (error) {
    await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
    console.error(`FAIL: ${error.message}\nScreenshot: ${join(out, 'failure.png')}`);
    process.exitCode = 1;
} finally {
    if (errors.length) {
        console.error(`Page errors:\n${errors.join('\n')}`);
        process.exitCode = 1;
    }
    await browser.close();
}
