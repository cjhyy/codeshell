from pathlib import Path
import json,hashlib,datetime,re,subprocess,collections
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round87-frontier-selection')
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b): return hashlib.sha256(b).hexdigest()
def pointer(s): return str(s).replace('~','~0').replace('/','~1')
pins=json.loads((OUT/'candidate-initial-pins.json').read_text())['files']; targets={r['path']:r for r in pins}; shas={r['sha256']:r['path'] for r in pins}
cmd=['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.MD','-g','*.json']
r=subprocess.run(cmd,cwd=ROOT,capture_output=True)
(OUT/'history-inventory-command.json').write_text(json.dumps({'command':cmd,'exitCode':r.returncode,'stderr':r.stderr.decode(),'stdoutPathCount':len(r.stdout.splitlines())},indent=2)+'\n')
assert r.returncode==0
paths=[]; excluded=[]
for p in sorted(set(r.stdout.decode().splitlines())):
 m=re.match(r'^docs/audit-\d{4}-\d{2}-\d{2}-round(\d+)(?:/|$)',p)
 (excluded if m and int(m.group(1))>=50 else paths).append(p)
start=now(); inventory=[]; claims=[]; hits=[]; counts=collections.Counter(); errors=[]; qualifierKeys=collections.Counter()
sourcePathRx=re.compile(r'^(?:packages|tests|scripts|bench)/[^\n]+\.(?:ts|tsx|js|jsx|mjs|cjs)$')
hashRx=re.compile(r'^[0-9a-fA-F]{64}$')
def sourcepath(v):
 if not isinstance(v,str): return None
 if v.startswith(str(ROOT)+'/'): v=v[len(str(ROOT))+1:]
 return v if sourcePathRx.fullmatch(v) else None

def visit(x,doc,ptr,docsha):
 if isinstance(x,dict):
  directPaths={sourcepath(v) for v in x.values() if sourcepath(v)}
  targetPaths=directPaths&targets.keys()
  hashFields={str(k):v.lower() for k,v in x.items() if isinstance(v,str) and hashRx.fullmatch(v) and ('sha' in str(k).lower() or 'hash' in str(k).lower())}
  uniqueHashes=set(hashFields.values())
  if targetPaths:
   qualifiers={k:v for k,v in x.items() if any(t in k.lower() for t in ['scope','coverage','reviewmode','readmode']) or k.lower() in ['review','read','inspection','kind']}
   ranges={k:v for k,v in x.items() if 'range' in k.lower() or k.lower() in ['readlines','selectedlines','semanticlines','frozenlines','lines','linecount','totallines','semanticlinecount','displayedlinecount','bodylines','additionalsnippetlines','additionalnavigationsnippetlines']}
   for k in qualifiers: qualifierKeys[k]+=1
   # Store qualifiers/ranges, never source capture/text/body values.
   for p in sorted(targetPaths):
    claims.append({'document':doc,'documentSha256':docsha,'jsonPointer':ptr,'path':p,'sameObjectUniqueSourcePath':len(directPaths)==1,'sameObjectPathCount':len(directPaths),'hashFields':hashFields,'sameObjectUniqueHash':len(uniqueHashes)==1,'sameCurrentSourceSha':len(uniqueHashes)==1 and next(iter(uniqueHashes))==targets[p]['sha256'],'qualifiers':qualifiers,'ranges':ranges,'canonicalManifestNameHint':'manifest' in Path(doc).name.lower() and not any(t in Path(doc).name.lower() for t in ['history','coverage','receipt','index'])})
  for k,v in x.items(): visit(v,doc,ptr+'/'+pointer(k),docsha)
 elif isinstance(x,list):
  for i,v in enumerate(x): visit(v,doc,ptr+'/'+str(i),docsha)
 else:
  counts['jsonScalarValues']+=1
  if isinstance(x,str):
   counts['jsonStringValues']+=1
   exact=sourcepath(x)
   if exact in targets: hits.append({'document':doc,'pointer':ptr,'kind':'exact-path-value','path':exact})
   elif x in shas: hits.append({'document':doc,'pointer':ptr,'kind':'exact-current-sha-value','path':shas[x]})
   else:
    # Locator count only, no historical source text copied or displayed.
    for p in targets:
     if p in x: counts['jsonContainingTargetPathValues']+=1; break
for p in paths:
 b=(ROOT/p).read_bytes(); h=sha(b); inventory.append({'path':p,'bytes':len(b),'sha256':h})
 if Path(p).suffix.lower()=='.md':
  counts['markdownFiles']+=1
  text=b.decode('utf-8')
  for i,line in enumerate(text.splitlines(),1):
   for target in targets:
    if target in line: hits.append({'document':p,'line':i,'kind':'markdown-path-locator','path':target})
 else:
  counts['jsonFiles']+=1
  try: visit(json.loads(b),p,'',h)
  except Exception as e: errors.append({'path':p,'errorType':type(e).__name__,'message':str(e)})
counts['historyFiles']=len(paths); counts['excludedAudit50PlusFiles']=len(excluded)
counts['archiveExactDirectoryFiles']=sum('archive' in Path(p).parts for p in paths)
counts['archiveSubstringFiles']=sum('archive' in p for p in paths)
counts['claims']=len(claims); counts['canonicalManifestHintClaims']=sum(c['canonicalManifestNameHint'] for c in claims)
(OUT/'history-initial-inventory.json').write_text(json.dumps({'capturedUTC':start,'method':cmd,'exclusion':'Audit directory round>=50; all docs/bugs MD and recursively JSON scalar values including archives; keys not searched as value text. No tmp packets scanned.','files':inventory},ensure_ascii=False,indent=2)+'\n')
(OUT/'history-claims.json').write_text(json.dumps({'capturedUTC':start,'metadataOnly':True,'association':'Same-object direct unique source-path and unique hash preferred; ambiguous objects retained, not promoted. Qualifiers/ranges only; no source body/capture copied.','claims':claims},ensure_ascii=False,indent=2)+'\n')
(OUT/'history-locators.json').write_text(json.dumps({'cap':None,'count':len(hits),'actualHumanRead':'Locators only; canonical qualifiers reviewed separately. No full historical source captures read.','locators':hits},ensure_ascii=False,indent=2)+'\n')
summary={'startedUTC':start,'finishedUTC':now(),'counts':dict(counts),'parseErrors':errors,'qualifierKeyInventory':dict(qualifierKeys),'globalCoverageClassificationChanged':False,'productBodiesRead':0,'currentProductHashChecks':len(pins),'productExecutions':0,'gitOperations':0,'webAccesses':0,'errorsOrTruncationBeforeThisScript':0}
(OUT/'history-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False))
