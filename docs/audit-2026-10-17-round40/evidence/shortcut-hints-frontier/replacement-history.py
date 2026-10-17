from pathlib import Path
import datetime,hashlib,json
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');P=Path('/tmp/codeshell-audit-round42-data-frontier')
sha=lambda b:hashlib.sha256(b).hexdigest()
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
old=json.loads((P/'history.json').read_text());pin=json.loads((P/'replacement-initial-pins.json').read_text())['files'][0];source=pin['path'];source_sha=pin['sha256'];cap=120
needles={'source_path':[source.casefold()],'source_filename':['keyboardshortcuthints'],'source_sha':[source_sha],'ordinary_contract':['shortcut hint','shortcut display']};hits={k:[] for k in needles};totals={k:0 for k in needles};same=[];changed=[];errors=[];currentrows=[];strings=0;scalars=0
blobs={x['path']:(R/x['path']).read_bytes() for x in old['files']}
for x in old['files']:
 b=blobs[x['path']];row={'path':x['path'],'bytes':len(b),'sha256':sha(b)};currentrows.append(row)
 if row['bytes']!=x['bytes'] or row['sha256']!=x['sha256']:changed.append({'path':x['path'],'initialRow':x,'currentRow':row})
(P/'replacement-history-initial-pins.json').write_text(json.dumps({'capturedUTC':now(),'scope':'Same original3509 path inventory current bytes pinned before replacement matching. Original first scan retained separately; any byte drift recorded, never silently relabeled.','files':currentrows,'changedFromOriginal':changed},ensure_ascii=False,indent=2)+'\n')
def units(v,ptr=''):
 global strings,scalars
 if isinstance(v,dict):
  if source in v.values() and source_sha in v.values():same.append({'path':current,'jsonPointer':ptr,'row':v})
  for k,z in v.items():yield from units(z,ptr+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(v,list):
  for i,z in enumerate(v):yield from units(z,ptr+'/'+str(i))
 else:
  scalars+=1
  if isinstance(v,str):strings+=1;yield ptr,v
for current,b in blobs.items():
 text=b.decode()
 if current.lower().endswith('.json'):
  try:values=list(units(json.loads(text)))
  except Exception as e:errors.append({'path':current,'error':repr(e)});continue
 else:values=[(None,text)]
 for ptr,v in values:
  folded=v.casefold()
  for g,terms in needles.items():
   for t in terms:
    totals[g]+=folded.count(t);start=0
    while len(hits[g])<cap:
     i=folded.find(t,start)
     if i<0:break
     hits[g].append({'path':current,'jsonPointer':ptr,'line':v.count('\n',0,i)+1,'needle':t,'context':v[max(0,i-300):min(len(v),i+len(t)+650)],'sourceSha256':sha(b)});start=i+len(t)
u={}
for g,rows in hits.items():
 for i,x in enumerate(rows):
  k=sha(x['context'].encode());u.setdefault(k,{'context':x['context'],'locators':[]})['locators'].append({'group':g,'index':i,'path':x['path'],'jsonPointer':x['jsonPointer'],'line':x['line']})
d={'scannedUTC':now(),'scope':'All original3509 docs/bugs MD and recursive JSON scalar values including archives/frozen38, excluding original mutable39/future40/41/42; one replacement leaf, no product body read before this gate.','inventoryFiles':len(blobs),'jsonStringValues':strings,'jsonScalarValues':scalars,'patterns':needles,'capPerGroup':cap,'hitTotals':totals,'retained':{k:len(v) for k,v in hits.items()},'hits':hits,'uniqueContextCount':len(u),'uniqueContexts':list(u.values()),'samePathShaRows':same,'changedFromOriginal':changed,'parseErrors':errors,'productExecutions':0,'gitCommands':0}
(P/'replacement-history.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:d[k] for k in ['inventoryFiles','jsonStringValues','jsonScalarValues','hitTotals','retained','uniqueContextCount','samePathShaRows','changedFromOriginal','parseErrors']},ensure_ascii=False,indent=2))
