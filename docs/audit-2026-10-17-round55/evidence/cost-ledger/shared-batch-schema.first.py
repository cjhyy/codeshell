from pathlib import Path
import json,hashlib,datetime
P=Path('/tmp/codeshell-audit-round125-agent-registry/history-batch.json');b=P.read_bytes();d=json.loads(b);O=Path('/tmp/codeshell-audit-round124-cost-ledger');ref=dict(createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),source=str(P),bytes=len(b),sha256=hashlib.sha256(b).hexdigest(),rootReportedFrozen=True,rootReportedCohort='5433 MD/JSON; frozen54 included,55+excluded; recursiveJSONvalues+archives;0parseerrors; Root method not executed by this reviewer')
(O/'shared-history-reference.json').write_text(json.dumps(ref,ensure_ascii=False,indent=2)+'\n');print(json.dumps(dict(reference=ref,topKeys=list(d)),ensure_ascii=False))
for k,v in d.items():
 if isinstance(v,dict):print(k,'keys',list(v)[:30])
 elif isinstance(v,list):print(k,'length',len(v),'firstType',type(v[0]).__name__if v else None)
 else:print(k,str(v)[:400])
