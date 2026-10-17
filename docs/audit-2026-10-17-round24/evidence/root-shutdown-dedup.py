"""Metadata-only historical scan. No product imports or test runs."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).with_suffix('.json')
PATTERNS = {
    'shutdown_exact': r'settlePackagedPet|packaged-pet-shutdown|safeToCleanup',
    'ui_script': r'e2e-ui-packaged|Packaged UI acceptance failed|UI.only fixture',
    'retention_context': r'(HOME|home).{0,100}(assertion|failure|failed|失败|保留)|(cleanup|删除).{0,100}(assertion|failure|failed|失败|保留)',
}

def leaves(value, location='$'):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from leaves(child, f'{location}.{key}')
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from leaves(child, f'{location}[{index}]')
    else:
        yield location, value

compiled = {key: re.compile(pattern, re.I) for key, pattern in PATTERNS.items()}
counts = {key: 0 for key in PATTERNS}
hits = {key: [] for key in PATTERNS}
scanned = dict(markdownFiles=0, jsonFiles=0, jsonStringLeaves=0, jsonScalarLeaves=0)
inventory, errors = [], []
for directory in [ROOT / 'docs', ROOT / 'bugs']:
    for path in sorted(directory.rglob('*')):
        if not path.is_file() or path.suffix not in ['.md', '.json'] or 'audit-2026-10-17-round24' in path.parts:
            continue
        raw = path.read_bytes()
        relative = str(path.relative_to(ROOT))
        inventory.append(dict(path=relative, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
        try:
            body = raw.decode()
            if path.suffix == '.json':
                scanned['jsonFiles'] += 1
                units = list(leaves(json.loads(body)))
                scanned['jsonScalarLeaves'] += len(units)
                scanned['jsonStringLeaves'] += sum(isinstance(value, str) for _, value in units)
                units = [(location, value if isinstance(value, str) else json.dumps(value)) for location, value in units]
            else:
                scanned['markdownFiles'] += 1
                units = [('$', body)]
            for location, body in units:
                for key, pattern in compiled.items():
                    for match in pattern.finditer(body):
                        counts[key] += 1
                        if len(hits[key]) < 100:
                            hits[key].append(dict(file=relative, location=location, context=body[max(0,match.start()-160):match.end()+400]))
        except Exception as error:
            errors.append(dict(file=relative, error=str(error)))
OUT.write_text(json.dumps(dict(baseline='c9056c8047a8e75ab2469e59bf1d3fedd9ad7272', scope='All prior docs/bugs MD and recursively parsed JSON scalars, archives included; current round excluded. Read-time inventory, not semantic exhaustion.', patterns=PATTERNS, scanned=scanned, parseErrors=errors, matchCounts=counts, maxContextsPerPattern=100, hits=hits, inventory=inventory), ensure_ascii=False, indent=2)+'\n')
print(json.dumps(dict(scanned=scanned, parseErrors=errors, matchCounts=counts)))
