// Loads a page and prints console messages, page errors and failed requests.
// Exits 1 on any page error.
//
//   BASE_URL=http://localhost:4330 PAGE_PATH=/ node console-log.mjs
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:4330';
const path = process.env.PAGE_PATH ?? '/';

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const page = await browser.newPage();
let pageErrors = 0;

page.on('console', (message) => console.log(`[console.${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => (pageErrors++, console.log(`[pageerror] ${error.message}`)));
page.on('requestfailed', (request) =>
    console.log(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`)
);
page.on('response', (response) => {
    if (response.status() >= 400) console.log(`[http ${response.status()}] ${response.url()}`);
});

await page.goto(new URL(path, baseUrl).href, { waitUntil: 'networkidle' });
await browser.close();

console.log(pageErrors ? `${pageErrors} page error(s)` : 'No page errors');
process.exitCode = pageErrors ? 1 : 0;
