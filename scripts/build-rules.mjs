import {writeFileSync,readFileSync} from 'node:fs';
import '../extension/policy.js';
const path = new URL('../extension/rules.json',import.meta.url);
const output = JSON.stringify(globalThis.SocialPolicy.staticRules(),null,2)+'\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path,'utf8') !== output) throw Error('Run bun run build:rules to update the packaged rules.');
} else writeFileSync(path,output);
