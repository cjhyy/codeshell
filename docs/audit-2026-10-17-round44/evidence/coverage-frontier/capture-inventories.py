from pathlib import Path
import datetime, hashlib, json, re, subprocess
from collections import Counter

ROOT = Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT = Path('/tmp/codeshell-audit-round49-coverage-frontier')
UTC = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
SHA = lambda b: hashlib.sha256(b).hexdigest()
def dump(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
def rg_files(*args):
    p = subprocess.run(['rg', '--files', '--hidden', *args], cwd=ROOT, capture_output=True, text=True, check=True)
    return sorted(set(p.stdout.splitlines()))
source_paths = rg_files('-g', '*.ts', '-g', '*.tsx', '-g', '!**/node_modules/**', '-g', '!**/.git/**')
source_rows = []
for p in source_paths:
    b = (ROOT / p).read_bytes()
    source_rows.append({'path':p, 'bytes':len(b), 'sha256':SHA(b), 'lines':len(b.splitlines())})
current = {r['path']:r for r in source_rows}
dump('package-inventory.json', {'capturedUTC':UTC(), 'scope':'Current repository rg-visible TS/TSX filesystem paths, respecting normal repository ignore rules, excluding .git/node_modules. Not a Git tracked set or semantic read. All source bytes used only for SHA/length/byte-splitlines count; no source text displayed, parsed or executed.', 'files':source_rows})
all_history = rg_files('--no-ignore', 'docs', 'bugs', '-g', '*.md', '-g', '*.MD', '-g', '*.json')
excluded_prefixes = tuple(f'docs/audit-2026-10-17-round{i}/' for i in range(43,50))
excluded = [p for p in all_history if p.startswith(excluded_prefixes)]
history_paths = [p for p in all_history if not p.startswith(excluded_prefixes)]
history_rows=[]
for p in history_paths:
    b=(ROOT/p).read_bytes();history_rows.append({'path':p,'bytes':len(b),'sha256':SHA(b),'kind':'json' if p.lower().endswith('.json') else 'md'})
dump('history-inventory.json', {'capturedUTC':UTC(), 'scope':'All docs/bugs MD and recursive JSON values including archive; frozen42 included; mutable/future43..49 excluded by exact directory rule. MD files only byte-pinned, not prose-classified for full coverage.', 'excludedPrefixes':list(excluded_prefixes), 'excluded':excluded, 'files':history_rows})


print(json.dumps({"sourceFiles":len(source_rows),"historyFiles":len(history_rows),"excluded":len(excluded),"metadataOnly":True},indent=2))
