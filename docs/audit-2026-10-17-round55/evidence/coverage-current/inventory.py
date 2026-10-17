from pathlib import Path
import json,hashlib,subprocess,datetime,collections
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round121-coverage-refresh');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat();sha=lambda b:hashlib.sha256(b).hexdigest()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
basep='docs/audit-2026-10-17-round44/evidence/coverage-status/current-inventory.json';transp='docs/audit-2026-10-17-round47/evidence/coverage-adapter/status-transitions.json';sumpp='docs/audit-2026-10-17-round47/evidence/coverage-adapter/summary.json';inputs=[]
for p in [basep,transp,sumpp,'docs/audit-2026-10-17-round47/evidence/coverage-adapter/current-source-delta.json','docs/audit-2026-10-17-round47/evidence/coverage-adapter/method.py','docs/audit-2026-10-17-round47/evidence/coverage-adapter/method.md','docs/audit-2026-10-17-round47/evidence/coverage-adapter/source-manifest.json','docs/audit-2026-10-17-round47/evidence/coverage-adapter/initial-input-pins.json']:
 b=(R/p).read_bytes();inputs.append(dict(path=p,bytes=len(b),sha256=sha(b),lines=len(b.splitlines())))
save('reconstruction-input-pins.json',dict(createdAt=now(),files=inputs,limitation='Metadata byte pins; original method.py is read only, never executed; original first method read was tool chunks7e5191/644b97 and before it hash was observed in978106.'))
base=json.loads((R/basep).read_bytes());trans=json.loads((R/transp).read_bytes());summ=json.loads((R/sumpp).read_bytes());m={x['path']:dict(x)for x in base['files']}
def oldlabel(x):return {'carryable-explicit-full':'full','carryable-explicit-selected-no-full':'selected'}.get(x['coverageStatus'],'unknown')
labels={p:oldlabel(x)for p,x in m.items()};errors=[]
for x in trans['rows']:
 if x['path']not in m or m[x['path']]['sha256']!=x['sha256']or labels[x['path']]!=x['states']['old49-current']:errors.append(x['path']);continue
 labels[x['path']]=x['states']['plus-frozen45']
counts=dict(collections.Counter(labels.values()));assert not errors;assert counts==summ['currentStages']['plusFrozen45'];assert len(m)==4643
# Current source files are bytes/line metadata only; no source body decoding.
cmd=['rg','--files','--hidden','-g','*.ts','-g','*.tsx','-g','!**/node_modules/**','-g','!**/.git/**'];ps=sorted(set(subprocess.run(cmd,cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()));cur={}
for p in ps:
 b=(R/p).read_bytes();cur[p]=dict(path=p,bytes=len(b),sha256=sha(b),lines=len(b.splitlines()))
unchanged={p for p in set(m)&set(cur)if m[p]['sha256']==cur[p]['sha256']};carried={p:labels[p]if p in unchanged else'unknown'for p in cur};delta=dict(added=sorted(set(cur)-set(m)),removed=sorted(set(m)-set(cur)),changed=[dict(path=p,oldSha256=m[p]['sha256'],currentSha256=cur[p]['sha256'],oldCoverage=labels[p])for p in sorted(set(m)&set(cur))if p not in unchanged])
save('current-source-inventory.json',dict(createdAt=now(),rootReportedBaseline='0d2d5418b0b4821fdb11dc87e328fce7e1f2433e',previousReadContext='16c1a40c7e3f0cf7701fccd723293bfb1291f105',gitCertified=False,filter=cmd,sourceBodyDecoded=False,sourceSemanticReads=0,files=[dict(**cur[p],frozen45Coverage=labels.get(p,'not-in-old-universe'),carryForwardCoverage=carried[p],oldSha256=m.get(p,{}).get('sha256'))for p in sorted(cur)]))
save('base-reconstruction.json',dict(createdAt=now(),baseInput=basep,transitionInput=transp,baseRows=len(m),transitions=len(trans['rows']),transitionErrors=errors,frozen45Counts=counts,currentUniverse=len(cur),carryForwardCounts=dict(collections.Counter(carried.values())),sourceDelta=delta,stage='Conservative frozen45 records carried to current exact SHA only; no46+ evidence yet',limits='Full/selected are exact-source metadata reading claims for retained purpose, not every contract checked or unread/remaining counts'))
# Only canonical source-manifest-shaped document names in frozen46..53; no general MD/JSON scalar/history walk.
roots=[f'docs/audit-2026-10-17-round{n}'for n in range(46,54)];allps=sorted(set(subprocess.run(['rg','--files',*roots,'-g','*source*manifest*.json'],cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()));man=[]
for p in allps:
 if any(t in Path(p).name for t in ['.first.','.scan','.raw.']):continue
 b=(R/p).read_bytes();d=json.loads(b);man.append(dict(path=p,bytes=len(b),sha256=sha(b),keys=list(d)if isinstance(d,dict)else None,objectType=type(d).__name__))
save('increment-manifest-inventory.json',dict(createdAt=now(),scope='Only source-manifest-named JSON files in frozen formal46..53; excludes54 and all other history/scalars; no author method execution',files=man,excludedNamedVariants=[p for p in allps if p not in {x['path']for x in man}]))
print(json.dumps(dict(reconstructed45=counts,transitions=len(trans['rows']),currentUniverse=len(cur),carryForward=dict(collections.Counter(carried.values())),delta=delta,manifestDocuments=len(man),excludedVariants=len(allps)-len(man)),ensure_ascii=False))
for x in man:print(json.dumps(dict(path=x['path'],keys=x['keys']),ensure_ascii=False))
