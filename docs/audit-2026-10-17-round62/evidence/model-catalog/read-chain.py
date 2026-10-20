from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
plan=[('packages/core/src/model-catalog/types.ts',[[66,112]],'product'),('packages/core/src/model-catalog/index.ts',[[68,106]],'product'),('packages/core/src/model-catalog/save-entry.ts',[[118,141]],'product'),('packages/core/src/tool-system/builtin/generate-image.ts',[[186,241],[424,445]],'product'),('packages/core/src/tool-system/builtin/generate-video.ts',[[234,265],[350,374]],'product'),('packages/core/src/model-catalog/gen-connections.test.ts',[[1,60],[72,85]],'test-declaration'),('packages/core/src/model-catalog/upsert.test.ts',[[29,76]],'test-declaration')]
pins=[]
for p,rs,kind in plan:
 b=(root/p).read_bytes();lines=b.decode().splitlines();assert all(1<=a<=z<=len(lines) for a,z in rs),(p,len(lines),rs)
 pins.append({'path':p,'bytes':len(b),'lines':len(lines),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':kind,'coverage':'selected','selectedLineRanges':rs})
(out/'chain-before-read-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
ex=[]
for p,rs,kind in plan:
 lines=(root/p).read_text().splitlines(keepends=True)
 print('\nSOURCE',p,'KIND',kind)
 for a,z in rs:
  text=''.join(lines[a-1:z]);ex.append({'path':p,'range':[a,z],'text':text,'selectedTextSha256':hashlib.sha256(text.encode()).hexdigest(),'bytes':len(text.encode())})
  for i in range(a-1,z): print(str(i+1)+': '+lines[i].rstrip('\n'))
(out/'chain-source-excerpts.json').write_text(json.dumps(ex,ensure_ascii=False,indent=2)+'\n')
