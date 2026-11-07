# /// script
# requires-python = ">=3.10"
# dependencies = ["google-re2==1.1.20251105"]
# ///
"""Compile real generated rules with RE2's 2 KiB budget, not JS RegExp."""
import json
from pathlib import Path
import subprocess
import re2

root = Path(__file__).resolve().parents[1]
source = """
import './extension/policy.js';
const P = globalThis.SocialPolicy;
console.log(JSON.stringify([...P.patterns, ...P.profilePatterns, ...P.personalEntries.map(entry=>entry.pattern),
  ...P.searchPatterns]));
"""
patterns = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', source], cwd=root))
options = re2.Options()
options.max_mem = 2048
options.never_capture = True
options.case_sensitive = True
options.log_errors = False
old = r'^https://(www\.|mobile\.)?(x\.com|twitter\.com)/([A-Za-z0-9_]{1,15}/status|i/web/status)/([0-9]+)(/(photo|video)/[1-4])?/?([?#].*)?$'
try:
    re2.compile(old, options=options)
except re2.error:
    pass
else:
    raise AssertionError('Original oversized rule must reproduce the failure')
for pattern in patterns:
    re2.compile(pattern, options=options)
print(f'RE2: original failure reproduced; all {len(patterns)} generated patterns fit max_mem=2048.')
