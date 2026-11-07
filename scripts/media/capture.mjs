// Regenerates the README screenshots and GIFs in docs/media from the real extension
// pages, with made-up data (scripts/media/demo.mjs) and a mocked extension runtime.
//
//   bun run media                 # needs Google Chrome
//   CHROME_PATH=/path/to/chrome bun run media
import http from 'node:http';
import {mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import puppeteer from 'puppeteer-core';
import {DEMO_SYNC_LINK, demoState} from './demo.mjs';

const OUT = 'docs/media';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, {recursive: true});

// ---- A static server for extension/, with a fake chrome.runtime injected into pages.
const state = demoState();
const mock = `<script>
  const feed = ${JSON.stringify({...state, active: true, size: 20, count: 20, limitMs: 900000})};
  let read = [];
  window.chrome = {
    runtime: {sendMessage: async m => {
      await new Promise(r => setTimeout(r, 30));
      if (m.type === 'feedStatus') return {size: 20, count: 20, active: true, endsAt: feed.endsAt, remainingMs: feed.remainingMs, sync: {configured: true, endpoint: 'https://your-sync-server.example', synced: true}};
      if (m.type === 'snapshot') return {...feed, read};
      if (m.type === 'feedRead') { read = m.read === false ? read.filter(id => !m.ids.includes(id)) : [...read, ...m.ids]; return {read}; }
      if (m.type === 'syncShare') return {link: ${JSON.stringify(DEMO_SYNC_LINK)}};
      return {ok: true};
    }},
    permissions: {request: async () => true},
  };
</script>`;
const types = {html: 'text/html', js: 'text/javascript', css: 'text/css'};
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (!/^[a-z-]+\.(html|js|css)$/.test(name)) { res.statusCode = 404; return res.end(); }
  let body;
  try { body = readFileSync(join('extension', name), 'utf8'); } catch { res.statusCode = 404; return res.end(); }
  if (name.endsWith('.html')) body = body.replace('<script', mock + '<script');
  res.setHeader('content-type', `${types[name.split('.').pop()]}; charset=utf-8`);
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--font-render-hinting=none']});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function open(path, {theme, width = 760, height = 760, scale = 2, mobile = false}) {
  const page = await browser.newPage();
  await page.setViewport({width, height, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile});
  await page.emulateMediaFeatures([{name: 'prefers-color-scheme', value: theme}, {name: 'prefers-reduced-motion', value: 'no-preference'}]);
  await page.goto(`${base}/${path}`, {waitUntil: 'networkidle0'});
  await page.evaluate(() => document.fonts.ready);
  // The feed page leaves for X on "open"; stay here in the demo.
  await page.evaluate(() => { if (globalThis.SocialFeedPage) globalThis.SocialFeedPage.navigate = () => {}; });
  await pause(300);
  return page;
}
/** A screenshot cropped to the page's content (and any open popup), with a margin. */
async function shot(page, name, margin = 36) {
  const box = await page.evaluate(() => {
    const parts = [...document.querySelectorAll('.app > *, .feed > *, .suggestions, .dialog')].map(el => el.getBoundingClientRect()).filter(r => r.height);
    return {top: Math.min(...parts.map(r => r.top)), bottom: Math.max(...parts.map(r => r.bottom)), width: innerWidth, height: innerHeight};
  });
  const y = Math.max(0, box.top - margin), bottom = Math.min(box.height, box.bottom + margin);
  await page.screenshot({path: join(OUT, name), clip: {x: 0, y, width: box.width, height: bottom - y}});
}

for (const theme of ['dark', 'light']) {
  // Main page.
  let page = await open('blocked.html', {theme, height: 640});
  await page.evaluate(() => document.activeElement?.blur());
  await shot(page, `dashboard-${theme}.png`);
  // The one input: choices for a handle.
  await page.click('#go');
  await page.keyboard.type('@mara_demo', {delay: 20});
  await pause(400);
  await shot(page, `search-${theme}.png`);
  await page.close();

  // For You deck.
  page = await open('feed.html', {theme, height: 560});
  await shot(page, `feed-${theme}.png`);
  await page.close();

  // Sync QR for the iPhone app (placeholder token).
  page = await open('blocked.html', {theme, height: 640});
  await page.evaluate(() => document.activeElement?.blur());
  await page.click('.sync-trigger');
  await page.waitForSelector('#sync-qr');
  await page.click('#sync-qr');
  await page.waitForSelector('svg.qr path');
  await pause(400);
  await shot(page, `sync-qr-${theme}.png`);
  await page.close();
}

await browser.close();
server.close();
console.log(`Wrote ${OUT}/`);
