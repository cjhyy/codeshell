from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
paths=['packages/core/src/model-catalog/types.ts','packages/core/src/model-catalog/index.ts','packages/core/src/model-catalog/save-entry.ts','packages/core/src/tool-system/builtin/generate-image.ts','packages/core/src/tool-system/builtin/generate-video.ts','packages/core/src/model-catalog/gen-connections.test.ts','packages/core/src/model-catalog/upsert.test.ts']
pins=[]
for p in paths:
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'test-declaration' if '.test.' in p else 'product','coverageBeforeRead':'hash-only'})
(out/'chain-before-navigation-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
plans=[(['rg','-n','genInstancesFromConnections|resolveInstance|paramValues|defaultModel|applyParams|resolveImageProvider|resolveVideoProvider'],paths[3:5]),(['rg','-n','upsertCatalogEntry|upsertModelPreset|safeParse|export function|modelPresets|modelPresetSchema'],paths[:3]),(['rg','-n','^describe|^  it|^  test|genInstancesFromConnections|upsertCatalogEntry|upsertModelPreset'],paths[5:])]
allnav=[]
for i,(cmd,ps) in enumerate(plans):
 r=subprocess.run(cmd+ps,cwd=root,capture_output=True,text=True)
 (out/f'chain-navigation-{i}.stdout.txt').write_text(r.stdout);(out/f'chain-navigation-{i}.stderr.txt').write_text(r.stderr);(out/f'chain-navigation-{i}.exit.json').write_text(json.dumps({'exitCode':r.returncode,'command':cmd+ps})+'\n')
 allnav.append({'command':cmd+ps,'exitCode':r.returncode,'output':r.stdout})
 print('\nNAV',i);print(r.stdout)
(out/'chain-navigation.json').write_text(json.dumps(allnav,ensure_ascii=False,indent=2)+'\n')
