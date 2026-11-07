// Bundles the React + Base UI pages into plain scripts the extension and the iOS app load.
// `--check` fails if the committed bundles are out of date.
import {build} from 'esbuild';
import {readFile, writeFile} from 'node:fs/promises';

const pages = {'src/ui/dashboard.jsx': 'extension/popup.js', 'src/ui/feed.jsx': 'extension/feed-page.js'};
const check = process.argv.includes('--check');
let stale = [];
for (const [entry, out] of Object.entries(pages)) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'iife', minify: true, legalComments: 'eof',  // keeps React/Base UI/uqr license notices
    jsx: 'automatic', target: ['chrome120', 'safari16'], define: {'process.env.NODE_ENV': '"production"'},
    banner: {js: `// Generated from ${entry} by scripts/build-ui.mjs. Do not edit.`},
  });
  const code = result.outputFiles[0].text;
  if (check) { if ((await readFile(out, 'utf8').catch(() => '')) !== code) stale.push(out); }
  else { await writeFile(out, code); console.log(`${out} ${(code.length / 1024).toFixed(0)} KB`); }
}
if (stale.length) { console.error(`Out of date: ${stale.join(', ')}. Run bun run build:ui.`); process.exit(1); }
