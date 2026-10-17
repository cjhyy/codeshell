from pathlib import Path
import json,hashlib,datetime,subprocess
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round168-model-traces')
known=set((out/'filenames.first.stdout.txt').read_text().splitlines())
paths=['packages/core/src/model-traces/context.ts','packages/core/src/model-traces/native-process.ts','packages/core/src/model-traces/types.ts']
extra=[p for p in sorted(known) if p.endswith('.test.ts') and any(n in Path(p).name for n in ['sanitize','native','context'])]
print('test filename inventory',json.dumps(extra))
# Only the directly named native frame decoder test is eligible if such a file actually exists.
paths += [p for p in extra if Path(p).name=='native-frames.test.ts']
pins=[]
for p in paths:
 assert p in known,p
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'coverage':'hash-only before line navigation','sourceKind':'test-declaration' if '.test.' in p else 'product'})
(out/'chain-before-navigation-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
plans=[(['rg','-n','sanitizeTraceValue|createNativeModelTraceFrameDecoder|frameDecoder|decoder\.read|\.clear\(|recordRequest|recordResponse|ModelTraceContentState|contentState|sanitize'],paths[:3])]
if len(paths)>3:plans.append((['rg','-n','^describe|^  (test|it)\('],paths[3:]))
results=[]
for i,(cmd,ps) in enumerate(plans):
 r=subprocess.run(cmd+ps,cwd=root,capture_output=True,text=True);results.append({'command':cmd+ps,'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr});print('NAV',i);print(r.stdout)
(out/'chain-navigation.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
