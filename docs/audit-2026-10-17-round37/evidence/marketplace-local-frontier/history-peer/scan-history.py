from pathlib import Path
import datetime,hashlib,json,re,subprocess
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round37-marketplace-local-frontier/history-peer')
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
sha=lambda b:hashlib.sha256(b).hexdigest()
def dump(n,j): (OUT/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
r=subprocess.run(['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.MD','-g','*.json'],cwd=ROOT,capture_output=True,text=True,check=True)
raw=r.stdout
(OUT/'inventory.raw.txt').write_text(raw)
allpaths=sorted(set(raw.splitlines()))
excluded=[p for p in allpaths if re.search(r'^docs/audit-2026-10-17-round(?:35|36|37)(?:/|$)',p)]
paths=[p for p in allpaths if p not in set(excluded)]
blobs={p:(ROOT/p).read_bytes() for p in paths}
rows=[{'path':p,'bytes':len(blobs[p]),'sha256':sha(blobs[p]),'kind':'json' if p.lower().endswith('.json') else 'md','archiveBySubstring':('archiv' in p.lower())} for p in paths]
dump('initial-pins.json',{'capturedUTC':now(),'phase':'all selected file bytes read and pinned before recursive scalar scanning','inventoryCommand':r.args,'inventoryExit':r.returncode,'inventoryRawSha256':sha(raw.encode()),'discovered':len(allpaths),'excludedExactMutableCurrentDirections':excluded,'files':rows,'productAttempts':0,'gitCommands':0})
patterns={
 'helper':r'uninstallTarget|getUninstallTarget|resolveUninstallTarget',
 'local_marketplace':r'marketplace[^\n]{0,100}[\"\x27]local[\"\x27]|[\"\x27]local[\"\x27][^\n]{0,100}marketplace',
 'literal_namespace':r'(?:marketplace|marketplaces)[^\n]{0,180}(?:collision|reserved|literal|namespace|同名|碰撞|保留)|(?:collision|reserved|literal|namespace|同名|碰撞|保留)[^\n]{0,180}(?:marketplace|marketplaces)',
 'old_branch':r'missing.local|truthy.local|marketplace\s*(?:===|!==|:|=)\s*[\"\x27]local[\"\x27]',
 'source_name':r'(?:marketplaceName|marketplace\s+name|marketplace.*named)[^\n]{0,120}local',
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
cap=160
hits={k:[] for k in patterns}; totals={k:0 for k in patterns}; scalar=0; strings=0; errors=[]
def units(v,ptr=''):
 global scalar,strings
 if isinstance(v,dict):
  for k,x in v.items():
   esc=str(k).replace('~','~0').replace('/','~1')
   yield from units(x,ptr+'/'+esc)
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from units(x,ptr+'/'+str(i))
 else:
  scalar+=1
  if isinstance(v,str):
   strings+=1;yield ptr,v
for p in paths:
 s=blobs[p].decode('utf8')
 if p.lower().endswith('.json'):
  try: content=list(units(json.loads(s)))
  except Exception as e:
   errors.append({'path':p,'error':repr(e)});continue
 else:content=[('',s)]
 for ptr,txt in content:
  for k,rx in compiled.items():
   ms=list(rx.finditer(txt))
   totals[k]+=len(ms)
   for m in ms:
    if len(hits[k])>=cap:break
    a=max(0,m.start()-420);b=min(len(txt),m.end()+850)
    excerpt=txt[a:b]
    hits[k].append({'path':p,'jsonPointer':ptr if p.lower().endswith('.json') else None,'matchStart':m.start(),'matchEnd':m.end(),'line':txt.count('\n',0,m.start())+1,'matched':m.group(0),'contextStart':a,'contextEnd':b,'context':excerpt,'sourceSha256':sha(blobs[p])})
summary={'scannedUTC':now(),'scope':'All docs/bugs MD and recursive JSON scalar VALUES, archives included; exact mutable audit round35 / future36 / future37 directories excluded. No product source read.','method':{'recursiveJson':'dictionary values and list elements recursively, no key search; all noncontainers counted as scalars, all strings scanned','md':'entire UTF8 text scanned','regexOnlyNotSemanticExhaustion':True,'navigationOutputNote':'Initial rg console response truncated. Full output was captured separately to inventory.raw.txt; no claim that truncated console inventory was read in full.','patterns':patterns,'retainedHitCapPerPattern':cap},'inventory':{'discovered':len(allpaths),'included':len(paths),'excluded':len(excluded),'md':sum(x['kind']=='md' for x in rows),'json':sum(x['kind']=='json' for x in rows),'archiveBySubstring':sum(x['archiveBySubstring'] for x in rows),'bytes':sum(x['bytes'] for x in rows),'jsonStringValues':strings,'jsonScalarValues':scalar,'jsonParseErrors':errors,'includesFrozenRound34':any(p.startswith('docs/audit-2026-10-17-round34/') for p in paths)},'hitTotals':totals,'retainedHits':{k:len(v) for k,v in hits.items()},'files':rows,'productAttempts':0,'gitCommands':0}
dump('history.json',summary);dump('contexts.json',{'createdUTC':now(),'selection':'bounded first matches in sorted path / recursive-value traversal order; navigation only, explicit selected read decisions recorded separately','hits':hits})
print(json.dumps({'inventory':summary['inventory'],'hitTotals':totals,'retainedHits':summary['retainedHits']},ensure_ascii=False,indent=2))
