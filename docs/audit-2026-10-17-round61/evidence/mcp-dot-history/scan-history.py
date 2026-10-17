from pathlib import Path
from datetime import datetime,timezone
import re,json,hashlib,subprocess
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');OUT=Path('/tmp/codeshell-audit-round160-mcp-dot-history')
patterns={
'mcp-dot-name':r'(?:mcp|server|服务器|服务)[\s\S]{0,150}(?:dotted|dot[- ]?(?:name|key)|dots|含点|带点|点号|句点)',
'dot-mcp-name':r'(?:dotted|含点|带点|点号|句点)[\s\S]{0,150}(?:mcp|server|服务器|服务)',
'mcp-overlay-literal':r'capabilityOverrides\.mcp',
'mcp-nested-path':r'(?:mcp|server|服务器|服务)[\s\S]{0,130}(?:nested|嵌套|split|拆分|点分)',
'nested-mcp-path':r'(?:nested|嵌套|split|拆分|点分)[\s\S]{0,130}(?:mcp|server|服务器|服务)',
'overlay-token-path':r'(?:capabilityOverrides|setOverride|setDottedSetting)[\s\S]{0,130}(?:dotted|nested|嵌套|split|点分|含点|带点|点号)',
'dot-name-generic':r'(?:含点|带点|点号|dotted)[\s\S]{0,150}(?:capabilit|plugin|skill|override)',
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
cmd=['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.json'];r=subprocess.run(cmd,cwd=ROOT,text=True,capture_output=True)
(OUT/'inventory.first.stdout.txt').write_text(r.stdout);(OUT/'inventory.first.stderr.txt').write_text(r.stderr);(OUT/'inventory.first.exit.json').write_text(json.dumps({'exitCode':r.returncode,'command':cmd})+'\n')
paths=[];excluded=[]
for p in sorted(set(r.stdout.splitlines())):
 m=re.search(r'audit-2026-10-17-round(\d+)',p)
 if m and int(m[1])>=61:excluded.append(p)
 else:paths.append(p)
scalar=0;strings=0;errors=[];inventory=[];stats={k:{'matchedValues':0,'matchOccurrences':0,'matchedDocuments':set()} for k in patterns};hits={k:[] for k in patterns};cap=100

def values(v,ptr=''):
 global scalar,strings
 if isinstance(v,dict):
  for key,x in v.items():yield from values(x,ptr+'/'+str(key).replace('~','~0').replace('/','~1'))
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from values(x,ptr+'/'+str(i))
 else:
  scalar+=1
  if isinstance(v,str):strings+=1;yield ptr,v
for name in paths:
 b=(ROOT/name).read_bytes();inventory.append({'path':name,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 try:
  vs=values(json.loads(b)) if name.endswith('.json') else [('/text',b.decode('utf-8'))]
  for ptr,v in vs:
   for key,rx in compiled.items():
    matched=False
    for m in rx.finditer(v):
     matched=True;stats[key]['matchOccurrences']+=1
     if len(hits[key])<cap:
      a=max(0,m.start()-150);z=min(len(v),m.end()+220)
      row={'document':name,'location':ptr,'matchStart':m.start(),'matchEnd':m.end(),'windowStart':a,'windowEnd':z,'wholeValueCharacters':len(v),'window':v[a:z],'windowTruncated':a>0 or z<len(v)}
      if name.endswith('.md'):row['matchStartLine']=v.count('\n',0,m.start())+1;row['windowStartLine']=v.count('\n',0,a)+1
      hits[key].append(row)
    if matched:stats[key]['matchedValues']+=1;stats[key]['matchedDocuments'].add(name)
 except Exception as e:errors.append({'document':name,'errorType':type(e).__name__,'error':str(e)})
for k,s in stats.items():s['matchedDocuments']=sorted(s['matchedDocuments']);s['matchedDocumentCount']=len(s['matchedDocuments']);s['savedWindows']=len(hits[k]);s['capped']=s['matchOccurrences']>len(hits[k])
result={'at':datetime.now(timezone.utc).isoformat(),'root':str(ROOT),'rootReportedHead':'659b6b2ce5888723a40ce046cbbf643382cb130b','GitVerified':False,'method':'Fresh rg all hidden/unignored docs/bugs MD/JSON inventory; exclude formal61+. Each MD whole text is one search value, JSON only recursively traversed value strings, never keys. Regex may cross newlines within bounded150 characters. Counts distinguish values/occurrences/documents.','inventoryCommand':cmd,'excludedFormalAtOrAbove':61,'excludedPaths':excluded,'historyFiles':len(paths),'markdownFiles':sum(p.endswith('.md') for p in paths),'jsonFiles':sum(p.endswith('.json') for p in paths),'jsonValueScalarsVisited':scalar,'jsonStringValuesVisited':strings,'queries':patterns,'capPerQuery':cap,'counts':stats,'hits':hits,'errors':errors,'allSavedWindowsSemanticallyRead':False,'productExecution':0}
(OUT/'history-inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')
(OUT/'focused-history.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
summary={k:{kk:vv for kk,vv in s.items() if kk!='matchedDocuments'} for k,s in stats.items()}
print(json.dumps({'historyFiles':len(paths),'markdownFiles':result['markdownFiles'],'jsonFiles':result['jsonFiles'],'jsonValueScalarsVisited':scalar,'jsonStringValuesVisited':strings,'counts':summary,'errors':errors},ensure_ascii=False))
