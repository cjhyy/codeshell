from pathlib import Path
import json,re,hashlib,collections,subprocess
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
out=Path('/tmp/codeshell-audit-round25-link-frontier')
patterns={
'exact-pure-leaves':re.compile(r'packages/link/src/(?:catalog|types|recipes|figma|index)\.ts|localizeLinkText|getLinkProviderManifest|resolveLinkRecipeId|linkConnectionMetadata|LINK_CONNECTION_RECIPES'),
'link-manifest-config':re.compile(r'(?:Link|provider).{0,50}(?:manifest|catalog|清单|recipe|配置|双语|展示)|(?:manifest|catalog|recipe|清单).{0,50}(?:Link|provider)|fileSelectionLimitation',re.I),
'host-registry':re.compile(r'packages/host/src/(?:runtime|host-requests|index)\.ts|HostRuntime|Duplicate host capability|host startup.{0,30}rollback',re.I),
}
stats={'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0};files=[];errors=[];hits={k:[] for k in patterns};counts={k:0 for k in patterns};byfile={k:collections.Counter() for k in patterns};round24={'files':0,'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0}
def leaves(x,loc='$'):
 if isinstance(x,dict):
  for k,v in x.items():yield from leaves(v,loc+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(x,list):
  for i,v in enumerate(x):yield from leaves(v,loc+'['+str(i)+']')
 else:yield loc,x
for directory in ['docs','bugs']:
 for path in sorted((root/directory).rglob('*')):
  if not path.is_file() or path.suffix.lower() not in ['.md','.json']:continue
  raw=path.read_bytes();relative=str(path.relative_to(root));is24=relative.startswith('docs/audit-2026-10-17-round24/')
  files.append({'path':relative,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'currentRound24':is24})
  if is24:round24['files']+=1
  if path.suffix.lower()=='.md':
   stats['markdown']+=1
   if is24:round24['markdown']+=1
   rows=[(str(i),v) for i,v in enumerate(raw.decode().splitlines(),1)]
  else:
   stats['json']+=1
   if is24:round24['json']+=1
   try:tree=json.loads(raw)
   except Exception as e:errors.append({'path':relative,'error':str(e)});continue
   rows=[]
   for loc,value in leaves(tree):
    stats['scalarLeaves']+=1
    if is24:round24['scalarLeaves']+=1
    if isinstance(value,str):
     stats['stringLeaves']+=1
     if is24:round24['stringLeaves']+=1
    rows.append((loc,value if isinstance(value,str) else json.dumps(value,ensure_ascii=False)))
  for loc,value in rows:
   for name,p in patterns.items():
    for m in p.finditer(value):
     counts[name]+=1;byfile[name][relative]+=1
     if len(hits[name])<100:hits[name].append({'path':relative,'location':loc,'excerpt':value[max(0,m.start()-160):min(len(value),m.end()+550)],'wholeValueCharacters':len(value),'currentRound24':is24})
result={'readHead':subprocess.run(['git','rev-parse','HEAD'],cwd=root,capture_output=True,text=True,check=True).stdout.strip(),'roots':['docs','bugs'],'excluded':[],'includesArchive':True,'currentRound24':'Included and separately counted; neither historic validation nor current audit tests are inferred from these navigation hits.','round24Partition':round24,'inventory':files,'totals':{'files':len(files),**stats,'parseErrors':len(errors)},'parseErrors':errors,'patterns':{k:p.pattern for k,p in patterns.items()},'matchCounts':counts,'contextCap':100,'hits':hits,'matchesByFile':{k:dict(v) for k,v in byfile.items()},'note':'Read-time complete MD/JSON inventory and recursive scalar-value search, keys excluded. Keyword hits and capped contexts are navigation only, not semantic coverage or new findings. No product imports, runtime, tests, fixtures, VM, CLI, auth, network, or Git writes.'}
(out/'history.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'readHead':result['readHead'],'totals':result['totals'],'round24Partition':round24,'matchCounts':counts,'retained':{k:len(v) for k,v in hits.items()}},ensure_ascii=False))
