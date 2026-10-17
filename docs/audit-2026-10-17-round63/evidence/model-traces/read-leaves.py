from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round168-model-traces')
plan=[('packages/core/src/model-traces/native-frames.ts',[[1,90]]),('packages/core/src/model-traces/sanitize.ts',[[1,147]])]
pins=[]
for p,rs in plan:
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'coverage':'full','selectedLineRanges':rs,'sourceKind':'product'})
(out/'leaf-before-read-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
ex=[]
for p,rs in plan:
 lines=(root/p).read_text().splitlines(keepends=True);print('\nSOURCE',p)
 for a,z in rs:
  text=''.join(lines[a-1:z]);ex.append({'path':p,'range':[a,z],'text':text,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()})
  for i in range(a-1,z):print(str(i+1)+': '+lines[i].rstrip('\n'))
(out/'leaf-excerpts.json').write_text(json.dumps(ex,ensure_ascii=False,indent=2)+'\n')
(out/'gate-decisions.json').write_text(json.dumps({'classification':{'decision':'same-SHA old full; current body not read','canonical':'docs/audit-2026-10-17-round18/evidence/presentation-source-manifest.json#/files/7','oldScope':'full static read; not imported/executed','reportRange':'docs/audit-2026-10-17-round18/presentation.md:15-36'},'nativeFramesAndSanitize':{'decision':'limited static reading allowed; no explicit canonical old full established in bounded gate','notClaimed':'first read, historically unread or unique new source coverage'},'oldFailures':'Prior Core model-trace backend/i18n dynamic failures remain skipped; no test/import/fixture execution'},ensure_ascii=False,indent=2)+'\n')
