// Renders the icons from assets/icon.svg and assets/mark.svg (needs Google Chrome):
//   ios/Dreamscroll/Assets.xcassets/AppIcon.appiconset/icon.png   1024px, square, opaque
//   extension/icons/icon-{16,32,48,128}.png                        rounded, transparent corners
//   docs/media/icon.png                                            256px, rounded (README)
//   ios/Dreamscroll/Assets.xcassets/Mark.imageset/mark.svg         the one-color mark (tinted in SwiftUI)
//
//   bun run icons
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const icon = readFileSync('assets/icon.svg', 'utf8');
const browser = await puppeteer.launch({executablePath: CHROME, headless: true});

async function render(path, size, {radius = 0} = {}) {
  const page = await browser.newPage();
  await page.setViewport({width: size, height: size});
  await page.setContent(`<style>html,body{margin:0;background:transparent}
    div{width:${size}px;height:${size}px;overflow:hidden;border-radius:${radius * size}px}
    svg{display:block;width:100%;height:100%}</style><div>${icon}</div>`);
  await page.screenshot({path, omitBackground: radius > 0});
  await page.close();
}

const appIcon = 'ios/Dreamscroll/Assets.xcassets/AppIcon.appiconset/icon.png';
await render(appIcon, 1024);
// iOS app icons must be opaque (rendered without omitBackground, so they are).
if (/hasAlpha: yes/.test(execFileSync('sips', ['-g', 'hasAlpha', appIcon], {encoding: 'utf8'}))) throw Error(`${appIcon} has an alpha channel`);

mkdirSync('extension/icons', {recursive: true});
for (const size of [16, 32, 48, 128]) await render(`extension/icons/icon-${size}.png`, size, {radius: 0.22});
await render('docs/media/icon.png', 256, {radius: 0.22});

const markSet = 'ios/Dreamscroll/Assets.xcassets/Mark.imageset';
mkdirSync(markSet, {recursive: true});
// SwiftUI tints it, so fill with black; the asset is a template image.
writeFileSync(`${markSet}/mark.svg`, readFileSync('assets/mark.svg', 'utf8').replaceAll('currentColor', '#000000'));
writeFileSync(`${markSet}/Contents.json`, JSON.stringify({
  images: [{filename: 'mark.svg', idiom: 'universal'}],
  info: {author: 'xcode', version: 1},
  properties: {'preserves-vector-representation': true, 'template-rendering-intent': 'template'},
}, null, 2) + '\n');

await browser.close();
console.log('Icons written.');
