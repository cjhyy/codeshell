from pathlib import Path
from datetime import datetime,timezone
import json,hashlib
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round88-plugin-presentation');h=json.loads((out/'history.json').read_text());cap=20;hits={'helper-names':0,'plugin-logo-fallback':0,'plugin-screenshot-cap':0};saved={x:[] for x in hits};drift=[]
def unit(rel,ptr,s):
 t=s.lower();tests={'helper-names':any(x in s for x in ['pluginLogoSources','pluginScreenshotDataUrls','shouldLoadPluginListMedia']),'plugin-logo-fallback':('plugin' in t or '插件' in s) and 'logo' in t and any(x in t for x in ['fallback','回退','darklogo','logodark']),'plugin-screenshot-cap':('plugin' in t or '插件' in s) and ('screenshot' in t or '截图' in s) and any(x in t for x in ['slice(0, 3)','最多三','最多3','up to three','first three'])}
 for key,v in tests.items():
  if not v:continue
  hits[key]+=1
  if len(saved[key])<cap:
   needle=next((n for n in ['pluginLogoSources','pluginScreenshotDataUrls','shouldLoadPluginListMedia'] if n in s),None) if key=='helper-names' else None
   pos=s.find(needle) if needle else max(0,min([x for x in [t.find('logo'),t.find('screenshot'),s.find('截图')] if x>=0] or [0]));a=max(0,pos-300);z=min(len(s),pos+800);saved[key].append({'path':rel,'pointer':ptr,'valueChars':len(s),'contextStart':a,'contextEnd':z,'text':s[a:z],'wholeValueIncluded':a==0 and z==len(s)})
def walk(rel,ptr,v):
 if isinstance(v,dict):
  for k,x in v.items():walk(rel,ptr+'/'+str(k).replace('~','~0').replace('/','~1'),x)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(rel,ptr+'/'+str(i),x)
 elif isinstance(v,str):unit(rel,ptr,v)
for x in h['inventory']:
 b=(repo/x['path']).read_bytes()
 if hashlib.sha256(b).hexdigest()!=x['sha256']:drift.append(x['path'])
 if x['path'].endswith('.md'):unit(x['path'],'markdown-text',b.decode())
 else:walk(x['path'],'',json.loads(b))
r={'queriedUTC':datetime.now(timezone.utc).isoformat(),'scope':'Same original4693 machine members, simple literal/AND queries after source-derived helper names known; no universal history semantic exhaustion. Cap20 windows.','queries':{k:{'hits':v,'cap':cap,'retained':len(saved[k])} for k,v in hits.items()},'drift':drift,'contexts':saved};(out/'history-causes.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in r.items() if k!='contexts'},ensure_ascii=False));print('locators',json.dumps({k:[{'index':i,'path':x['path'],'pointer':x['pointer']} for i,x in enumerate(v)] for k,v in saved.items()},ensure_ascii=False))
