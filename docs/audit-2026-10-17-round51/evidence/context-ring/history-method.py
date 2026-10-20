"""Own audit metadata scanner only. Does not import or execute product code."""
import collections
import datetime
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT = pathlib.Path('/tmp/codeshell-audit-round94-context-ring')
TARGET = 'packages/desktop/src/renderer/chat/ContextRing.tsx'
SHA = 'b28fbfc2e74fdb645cc5b2cb935eb0fb6a5e1f896b6150a121a75294013baa3d'
CAP = 100
FIELD_NAMES = {'path', 'file', 'source', 'bytes', 'lines', 'sha', 'sha256', 'coverage',
    'scope', 'readScope', 'inspectionScope', 'reviewMode', 'review', 'purpose',
    'selectedLineRanges', 'displayedLineRanges', 'ranges', 'lineRanges',
    'semanticLineCount', 'semanticLines', 'fullFileReadingClaimed',
    'initialSemanticReadSha256', 'sourceKind'}
ANCESTOR_NAMES = {'scope', 'readScope', 'inspectionScope', 'reviewMode', 'review',
    'purpose', 'role', 'limits', 'limitations', 'boundary', 'sourceCoverage', 'totals', 'counts'}

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def esc(value):
    return str(value).replace('~', '~0').replace('/', '~1')

def short(value, limit=900):
    if isinstance(value, str) and len(value) > limit:
        return {'boundedString': value[:limit], 'originalCharacters': len(value), 'truncatedProjection': True}
    if isinstance(value, list) and len(value) > 30:
        return {'first30MetadataValues': value[:30], 'originalItems': len(value), 'truncatedProjection': True}
    return value

started = now()
cmd = subprocess.run(['rg', '--files', 'docs', 'bugs'], cwd=ROOT, capture_output=True, text=True)
paths = []
excluded = []
for path in cmd.stdout.splitlines():
    if pathlib.PurePosixPath(path).suffix.lower() not in ('.md', '.json'):
        continue
    rounds = [int(x) for x in re.findall(r'(?:^|/)audit-[^/]*-round(\d+)(?:/|$)', path)]
    if any(x >= 51 for x in rounds):
        excluded.append(path)
    else:
        paths.append(path)
paths = sorted(set(paths))
inventory = []
counts = collections.Counter()
hits = collections.Counter()
contexts = {k: [] for k in ('path', 'sha', 'filename', 'oldCause')}
objects = []
errors = []

def visit_string(value, doc, pointer, docsha):
    lower = value.casefold()
    matches = {'path': TARGET in value, 'sha': SHA in value,
        'filename': 'contextring' in lower,
        'oldCause': ('context ring' in lower or 'contextring' in lower) and any(t in lower for t in
            ('percent', 'usage', 'token', 'denominator', 'budget', 'context window', 'threshold', '分母', '阈值', '用量', '上下文'))}
    for kind, matched in matches.items():
        if not matched:
            continue
        hits[kind] += 1
        if len(contexts[kind]) >= CAP:
            continue
        needle = TARGET if kind == 'path' else SHA if kind == 'sha' else 'contextring'
        pos = lower.find(needle.casefold())
        if pos < 0:
            pos = lower.find('context ring')
        left, right = max(0, pos - 220), min(len(value), pos + 620)
        contexts[kind].append({'document': doc, 'documentSha256': docsha, 'pointer': pointer,
            'text': value[left:right], 'valueCharacters': len(value), 'windowStart': left,
            'windowEnd': right, 'boundedWindowNotFullValue': left != 0 or right != len(value)})

def walk(value, doc, pointer, ancestors, docsha):
    if isinstance(value, dict):
        counts['objects'] += 1
        direct = {k:v for k,v in value.items() if isinstance(v, str)}
        if any(TARGET in v for v in direct.values()):
            objects.append({'document': doc, 'documentSha256': docsha, 'pointer': pointer,
                'originalObjectKeys': list(value),
                'metadataProjection': {k:short(v) for k,v in value.items() if k in FIELD_NAMES},
                'directPathBearingFields': {k:short(v) for k,v in direct.items() if TARGET in v},
                'ancestorLimitations': [{'pointer': p, 'metadata': {k:short(v) for k,v in a.items() if k in ANCESTOR_NAMES}}
                    for p,a in ancestors[-4:] if any(k in ANCESTOR_NAMES for k in a)],
                'projectionIsNotFullObjectOrSourceRead': True})
        for key, item in value.items():
            walk(item, doc, pointer + '/' + esc(key), ancestors + [(pointer, value)], docsha)
    elif isinstance(value, list):
        counts['arrays'] += 1
        for index, item in enumerate(value):
            walk(item, doc, pointer + '/' + str(index), ancestors, docsha)
    else:
        counts['scalars'] += 1
        if isinstance(value, str):
            counts['strings'] += 1
            visit_string(value, doc, pointer, docsha)

for path in paths:
    try:
        data = (ROOT / path).read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        inventory.append({'path': path, 'bytes': len(data), 'sha256': sha})
        text = data.decode('utf-8')
        if path.lower().endswith('.json'):
            counts['jsonFiles'] += 1
            walk(json.loads(text), path, '', [], sha)
        else:
            counts['mdFiles'] += 1
            visit_string(text, path, 'markdown-text', sha)
    except Exception as exc:
        errors.append({'path': path, 'type': type(exc).__name__, 'error': str(exc)})

save('history-contexts.json', {'perQueryCap': CAP, 'totalHits': dict(hits), 'retained': {k:len(v) for k,v in contexts.items()},
    'contexts': contexts, 'machineOnlyNoWindowsYetClaimedSemanticallyRead': True})
save('coverage-gate-objects.json', {'objects': objects, 'count': len(objects),
    'metadataProjectionOnly': True, 'notSemanticCoverageClaimsOrGuaranteedCanonical': True})
save('history.json', {'startedUTC': started, 'finishedUTC': now(), 'root': str(ROOT),
    'rootInitialReportedContextOnly': '8e366d97c92c614f00df989006f5b8208185246f',
    'rootLaterReportedDocsOnlyContext': '424ef9c8953eaaa295d24d63c49127aa8b3ea79e',
    'GitIndependentlyVerified': False,
    'scope': 'Fresh rg inventory of docs/bugs MD and JSON; full Markdown text plus recursive JSON scalar values. JSON keys not searched. Include frozen50, exclude numeric formal51+ and outside tmp. Machine traversal is not human semantic reading.',
    'inventoryCommand': ['rg', '--files', 'docs', 'bugs'], 'inventoryExitCode': cmd.returncode,
    'inventoryStderr': cmd.stderr, 'excludeNumericAuditRoundAtLeast': 51,
    'excludedPaths': sorted(set(excluded)), 'inventory': inventory, 'fileCount': len(inventory),
    'counts': dict(counts), 'exactArchiveOrUnderscoreArchiveMembers': sum(any(c in ('archive','_archive') for c in pathlib.PurePosixPath(p).parts) for p in paths),
    'literalArchiveComponentMembers': sum('archive' in pathlib.PurePosixPath(p).parts for p in paths),
    'substringArchiveMembers': sum('archive' in p for p in paths),
    'queries': {'path': TARGET, 'sha': SHA, 'filename': 'casefold literal contextring',
        'oldCause': '(casefold literal context ring OR contextring) AND any literal percent/usage/token/denominator/budget/context window/threshold/分母/阈值/用量/上下文'},
    'totalHits': dict(hits), 'capEach': CAP, 'retainedCounts': {k:len(v) for k,v in contexts.items()},
    'errors': errors, 'actualSemanticHistoryRead': 'None at scan time; later explicit selected metadata/window receipts, no full-history semantic exhaustion.'})
print(json.dumps({'files': len(inventory), 'counts': dict(counts), 'hits': dict(hits),
    'retained': {k:len(v) for k,v in contexts.items()}, 'directPathObjects': len(objects),
    'errors': errors, 'exitCode': cmd.returncode}, ensure_ascii=False))
