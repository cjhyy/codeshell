from pathlib import Path
from datetime import datetime,timezone
import json,hashlib
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round37-history-supplement')
inventory=json.loads((ROOT/'docs/audit-2026-10-17-round37/evidence/root-history.json').read_text())['inventory']
cap=200
criteria={'quoted-local-marketplace':'marketplace/市场/市集 AND double/single/backtick quoted local','admitted-name-local':'marketplace/市场/市集 AND local AND name/key/注册/登记/名称/derive','uninstall-local-marketplace':'marketplace/市场/市集 AND local AND uninstall/卸载','collision-local-marketplace':'marketplace/市场/市集 AND local AND collision/collid/namespace/reserved/错路由/误路由/误走/保留名/同名/碰撞','exact-cause-cooccurrence':'marketplace/市场/市集 AND local AND registry/registered/knownmarketplaces/marketplacename/marketplace name/登记/注册 AND uninstall/卸载 AND collision/collid/namespace/reserved/错路由/误路由/误走/保留名/同名/碰撞','local-suffix-uninstall':'@local AND uninstall/卸载'}
counts={k:0 for k in criteria};hits={k:[] for k in criteria};stats={'markdownFiles':0,'jsonFiles':0,'stringLeaves':0,'scalarLeaves':0,'markdownParagraphUnits':0};errors=[];drift=[];sourceRows=[];fileAnd=[]
def anyof(s,terms):return any(t in s for t in terms)
def scan(unit,path,at,kind):
 s=unit.lower();market=anyof(s,('marketplace','市场','市集'));local='local' in s;uninstall=anyof(s,('uninstall','卸载'));name=anyof(s,('name','key','注册','登记','名称','derive'));registered=anyof(s,('registry','registered','knownmarketplaces','marketplacename','marketplace name','登记','注册'));collision=anyof(s,('collision','collid','namespace','reserved','错路由','误路由','误走','保留名','同名','碰撞'));quote=any((q+'local'+q) in s for q in (chr(34),chr(39),chr(96)))
 flags={'quoted-local-marketplace':market and quote,'admitted-name-local':market and local and name,'uninstall-local-marketplace':market and local and uninstall,'collision-local-marketplace':market and local and collision,'exact-cause-cooccurrence':market and local and registered and uninstall and collision,'local-suffix-uninstall':'@local' in s and uninstall}
 for k,matched in flags.items():
  if matched:
   counts[k]+=1
   if len(hits[k])<cap:hits[k].append({'path':path,'at':at,'unitKind':kind,'unitCharacters':len(unit),'unitSha256':hashlib.sha256(unit.encode()).hexdigest(),'fullUnit':unit})
def walk(x,p,a='$'):
 if isinstance(x,dict):
  for k,v in x.items():walk(v,p,a+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(x,list):
  for i,v in enumerate(x):walk(v,p,a+'['+str(i)+']')
 else:
  stats['scalarLeaves']+=1
  if isinstance(x,str):stats['stringLeaves']+=1;scan(x,p,a,'JSON string value')
def md_units(text):
 lines=text.splitlines();buffer=[];start=1
 for i,line in enumerate(lines,1):
  if line.strip():
   if not buffer:start=i
   buffer.append(line)
  elif buffer:
   yield start,i-1,chr(10).join(buffer);buffer=[]
 if buffer:yield start,len(lines),chr(10).join(buffer)
started=datetime.now(timezone.utc).isoformat()
for r in inventory:
 p=r['path'];b=(ROOT/p).read_bytes();sha=hashlib.sha256(b).hexdigest();sourceRows.append({'path':p,'bytes':len(b),'sha256':sha,'matchesFormalInventory':len(b)==r['bytes'] and sha==r['sha256']})
 if len(b)!=r['bytes'] or sha!=r['sha256']:drift.append({'path':p,'formalBytes':r['bytes'],'formalSha256':r['sha256'],'currentBytes':len(b),'currentSha256':sha});continue
 try:
  text=b.decode('utf8')
  if p.lower().endswith('.json'):stats['jsonFiles']+=1;walk(json.loads(text),p)
  else:
   stats['markdownFiles']+=1
   for a,z,u in md_units(text):stats['markdownParagraphUnits']+=1;scan(u,p,[a,z],'Markdown paragraph')
   s=text.lower()
   if anyof(s,('marketplace','市场','市集')) and 'local' in s and anyof(s,('uninstall','卸载')) and anyof(s,('registry','registered','knownmarketplaces','marketplacename','marketplace name','登记','注册')):fileAnd.append({'path':p,'sha256':sha,'kind':'Whole-MD file cooccurrence only, not same paragraph/cause evidence'})
 except Exception as exc:errors.append({'path':p,'error':str(exc)})
d={'startedUTC':started,'completedUTC':datetime.now(timezone.utc).isoformat(),'scope':'Exact formal3318 inventory; Markdown paragraph units and all recursive JSON string value scalars; keys excluded; no regex or product/source/helper evaluation. All scalar leaves counted for comparison.','criteria':criteria,'occurrenceMeaning':'Number of matching units per query, not regex occurrences; one unit counted once per query. Markdown paragraph boundaries may miss cross-paragraph conjunctions; supplemental whole-MD cooccurrence filenames retained separately.','inventoryCount':len(inventory),'stats':stats,'counts':counts,'contextCapEach':cap,'retainedCounts':{k:len(v) for k,v in hits.items()},'hits':hits,'wholeMdFileCooccurrence':fileAnd,'inputFileHashChecks':sourceRows,'driftFromFormalInventory':drift,'parseErrors':errors,'productReads':0,'productCalls':0,'git':0,'limits':'Saved full units are not all semantically read merely because they are retained. Actual selected unit reading is a separate artifact. No absolute semantic exhaustion or first-report proof.'}
(OUT/'query-results.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+chr(10))
print(json.dumps({'inventory':len(inventory),'stats':stats,'counts':counts,'retained':d['retainedCounts'],'wholeMdFileCooccurrenceCount':len(fileAnd),'drift':drift,'errors':errors},ensure_ascii=False))
