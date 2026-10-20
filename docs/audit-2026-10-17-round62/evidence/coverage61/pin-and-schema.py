from pathlib import Path
import hashlib, json, datetime, io, contextlib, traceback

OUT = Path('/tmp/codeshell-audit-round163-coverage61')
ROOT = Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
PREFIX = 'docs/audit-2026-10-17-round61/'
PATHS = [PREFIX + 'README.md', PREFIX + 'evidence/coverage-migration/unified-current-index.json'] + [PREFIX + 'evidence/' + name + '/source-manifest.json' for name in ['capability-control', 'session-context-store', 'root-composition-lifetime', 'dotted-capability-review', 'root-dotted-mcp-decision', 'mcp-dot-readback-review']]

def digest(b): return hashlib.sha256(b).hexdigest()
def write(name, data): (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
def main():
    captured = {}
    pins = []
    for rel in PATHS:
        b = (ROOT / rel).read_bytes()
        pins.append({'path':rel,'bytes':len(b),'sha256':digest(b),'pinBeforeParse':True})
        captured[rel] = b
    write('initial-metadata-pins.json', {'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':pins})
    for name in ['CODESHELL.md', 'AGENTS.md']:
        b = (ROOT / name).read_bytes()
        pins.append({'path':name,'bytes':len(b),'sha256':digest(b),'role':'instructionHashOnlyCarriedPriorRead'})
    write('instruction-hash-pins.json', {'files':pins[-2:]})
    schemas = []
    for rel,b in captured.items():
        if not rel.endswith('.json'): continue
        j = json.loads(b)
        if rel.endswith('unified-current-index.json'):
            print('BASE TYPE',type(j).__name__)
            print('BASE KEYS',list(j)[:35] if isinstance(j,dict) else None)
            rows = j.get('files',j.get('paths',j.get('rows',[]))) if isinstance(j,dict) else j
            print('BASE ROW TYPE',type(rows).__name__,'LEN',len(rows))
            print('BASE FIRST',json.dumps(rows[0] if isinstance(rows,list) else next(iter(rows.items())),ensure_ascii=False)[:4000])
        else:
            files = j.get('files',[])
            schemas.append({'path':rel,'topLevelKeys':list(j),'files':files})
            print('MANIFEST',rel,'FILES',len(files),'TOP',list(j))
            for i,row in enumerate(files): print(i,json.dumps(row,ensure_ascii=False))
    write('manifest-schema-snapshot.json', {'documents':schemas})
    write('metadata-capture.json', {'scope':'Parsed canonical metadata only; no product source body','basePath':PATHS[1],'documents':len(captured)})
    print('PINNED',len(captured),'METADATA; INSTRUCTION HASH ONLY 2')

stdout,stderr=io.StringIO(),io.StringIO()
code=0
try:
    with contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr): main()
except BaseException:
    code=1
    traceback.print_exc(file=stderr)
(OUT/'schema-first.stdout').write_text(stdout.getvalue())
(OUT/'schema-first.stderr').write_text(stderr.getvalue())
write('schema-first.exit.json',{'exitCode':code,'method':'pin-and-schema.py','methodSHA256':digest(Path(__file__).read_bytes()),'kind':'standard-library metadata only; no product execution'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(stdout.getvalue().encode()),'stderrBytes':len(stderr.getvalue().encode())}))
