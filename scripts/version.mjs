// Sets one version everywhere it appears: the extension manifest, package.json files
// and the iOS app (MARKETING_VERSION; CURRENT_PROJECT_VERSION goes up by one).
//
//   bun run set-version -- 1.1.0
import {readFileSync, writeFileSync} from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('Usage: bun run set-version -- <major.minor.patch>'); process.exit(1); }

const json = (path, edit) => { const data = JSON.parse(readFileSync(path, 'utf8')); edit(data); writeFileSync(path, JSON.stringify(data, null, 2) + '\n'); };
json('extension/manifest.json', m => { m.version = version; });
json('package.json', p => { p.version = version; });
json('sync/package.json', p => { p.version = version; });

let yml = readFileSync('ios/project.yml', 'utf8');
yml = yml.replace(/MARKETING_VERSION: "[^"]*"/, `MARKETING_VERSION: "${version}"`);
yml = yml.replace(/CURRENT_PROJECT_VERSION: "(\d+)"/, (_, n) => `CURRENT_PROJECT_VERSION: "${Number(n) + 1}"`);
writeFileSync('ios/project.yml', yml);
console.log(`Version ${version}. Next: add a "## [${version}]" section to CHANGELOG.md, commit, then tag v${version}.`);
