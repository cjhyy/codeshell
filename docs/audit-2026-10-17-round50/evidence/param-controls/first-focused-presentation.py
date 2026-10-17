from pathlib import Path
import json,re
out=Path('/tmp/codeshell-audit-round90-param-controls'); x=json.loads((out/'focused-history.json').read_text())
for q,cs in x['contexts'].items():
 chosen=[(i,c) for i,c in enumerate(cs) if c['kind']=='markdown-paragraph' or re.search(r'ParamControls|paramValues|top_p|temperature',c['excerpt'],re.I)]
 print(json.dumps({'query':q,'chosenCount':len(chosen),'contexts':[{'index':i,**c} for i,c in chosen[:24]]},ensure_ascii=False,indent=2))
