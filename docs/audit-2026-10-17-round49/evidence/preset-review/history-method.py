from pathlib import Path
import datetime,hashlib,json,re,subprocess
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell'); B=Path('/tmp/codeshell-audit-round76-resolve-preset'); now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat(); sha=lambda x:hashlib.sha256(x).hexdigest()
def dump(n,x): (B/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
pins=json.loads((B/'initial-pins.json').read_text())['files']; sources={x['path']:x['sha256'] for x in pins if x['path'].startswith('packages/')}
r=subprocess.run(['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.MD','-g','*.json'],cwd=R,capture_output=True,text=True,check=True)
allpaths=sorted(set(r.stdout.splitlines()))
def exclude(p):
 m=re.match(r'^docs/audit-\d{4}-\d{2}-\d{2}-round(\d+)/',p)
 return bool(m and int(m.group(1))>=49)
excluded=[p for p in allpaths if exclude(p)]; paths=[p for p in allpaths if not exclude(p)]; blobs={p:(R/p).read_bytes() for p in paths}; rows=[{'path':p,'bytes':len(v),'sha256':sha(v),'kind':'json' if p.lower().endswith('.json') else 'md'} for p,v in blobs.items()]
(B/'history-inventory.raw.txt').write_text(r.stdout)
dump('history-initial-pins.json',{'capturedUTC':now(),'scope':'Fresh all docs/bugs MD/JSON byte inventory including archives; include frozen48 and exclude audit round>=49 on any date, not older review/round filenames.','excluded':excluded,'files':rows})
terms={'target_path':['packages/core/src/composition/resolve-preset.ts'],'target_sha':[sources['packages/core/src/composition/resolve-preset.ts']],'target_name':['resolve-preset'],'fallback_path':['packages/core/src/colorizer.ts'],'fallback_sha':[sources['packages/core/src/colorizer.ts']],'fallback_name':['colorizer'],'ordinary_contract':['resolvePreset','preset catalog','sliceAnsi']}; terms={k:[s.casefold() for s in v] for k,v in terms.items()}; cap=120; totals={k:0 for k in terms}; hits={k:[] for k in terms}; same=[]; strings=0; scalars=0; errors=[]
def walk(v,ptr='',parent=None):
 global strings,scalars
 if isinstance(v,dict):
  for path,hashv in sources.items():
   if path in v.values() and hashv in v.values(): same.append({'path':CURRENT,'jsonPointer':ptr,'sourcePath':path,'row':v})
  for k,x in v.items(): yield from walk(x,ptr+'/'+str(k).replace('~','~0').replace('/','~1'),v)
 elif isinstance(v,list):
  for i,x in enumerate(v): yield from walk(x,ptr+'/'+str(i),v)
 else:
  scalars+=1
  if isinstance(v,str): strings+=1; yield ptr,v,parent
for CURRENT,blob in blobs.items():
 text=blob.decode()
 try: units=walk(json.loads(text)) if CURRENT.lower().endswith('.json') else [('',text,None)]
 except Exception as e: errors.append({'path':CURRENT,'error':repr(e)}); continue
 for ptr,v,parent in units:
  folded=v.casefold()
  for group,needles in terms.items():
   for needle in needles:
    totals[group]+=folded.count(needle); start=0
    while len(hits[group])<cap:
     at=folded.find(needle,start)
     if at<0: break
     hits[group].append({'path':CURRENT,'jsonPointer':ptr if CURRENT.lower().endswith('.json') else None,'line':v.count('\n',0,at)+1,'needle':needle,'context':v[max(0,at-250):min(len(v),at+len(needle)+650)],'documentSha256':sha(blob)})
     start=at+len(needle)
summary={'capturedUTC':now(),'scope':'Fresh all docs/bugs MD text and recursive JSON scalar values; keys not searched as values. Include frozen48, exclude audit rounds>=49, archives retained. Not semantic exhaustion.','method':{'literalCasefoldedTerms':terms,'capPerGroup':cap,'sameObjectRows':'Every JSON object with immediate source path and matching SHA inspected independently of hit caps. Narrow ancestor/nested scope claims still need manual review.'},'inventory':{'discovered':len(allpaths),'included':len(paths),'excluded':len(excluded),'md':sum(x['kind']=='md' for x in rows),'json':sum(x['kind']=='json' for x in rows),'bytes':sum(x['bytes'] for x in rows),'jsonStringValues':strings,'jsonScalarValues':scalars,'archiveSubstring':sum('archiv' in p.lower() for p in paths),'archiveExactDirectory':sum(any(x in ['archive','_archive'] for x in Path(p).parts[:-1]) for p in paths),'parseErrors':errors,'includesFrozen48':any('/audit-2026-10-17-round48/' in p for p in paths)},'totals':totals,'retained':{k:len(v) for k,v in hits.items()},'samePathShaRows':len(same),'productRuns':0,'gitCommands':0}
dump('history.json',summary); dump('history-contexts.json',{'capturedUTC':now(),'hits':hits,'samePathShaRows':same,'notSemanticExhaustion':True}); print(json.dumps(summary,ensure_ascii=False))
