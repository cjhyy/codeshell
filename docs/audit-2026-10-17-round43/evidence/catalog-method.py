from pathlib import Path
from datetime import datetime,timezone
from collections import Counter
import hashlib,json,subprocess
R=Path(__file__).resolve().parents[3];O=R/'docs/audit-2026-10-17-round43';E=O/'evidence';baseline=json.loads((E/'integration-plan.json').read_text())['baseline']
def sha(b):return hashlib.sha256(b).hexdigest()
paths=[R/'docs/audit-2026-10-16/findings.json',R/'docs/audit-2026-10-17/findings.json']+[R/('docs/audit-2026-10-17-round'+str(n)+'/findings.json') for n in range(3,43)];assert len(paths)==42
sources=[];rows=[]
for i,p in enumerate(paths,1):
 b=p.read_bytes();relative=p.relative_to(R).as_posix();frozen=subprocess.check_output(['git','show',baseline+':'+relative],cwd=R);assert b==frozen
 j=json.loads(b);items=j['issues'] if 'issues'in j else j['findings'];assert isinstance(items,list);assert len(items)==j.get('total',j.get('count'))
 sources.append(dict(round=i,path=relative,bytes=len(b),sha256=sha(b),originalReportedCount=len(items),baselineBlobMatches=True))
 for x in items:
  priority=x.get('priority',x.get('severity'));assert priority in ['P0','P1','P2','P3'],(relative,x.get('id'),priority)
  rows.append(dict(id=x['id'],priority=priority,title=x['title'],sourceRound=i,canonicalFindings=relative,baseline=j.get('baseline'),originalStatus=x.get('status'),originalFixedFlag=x.get('fixed'),originalMainSourceDisposition=x.get('currentMainSourceDisposition'),statusInterpretation='Original dated fields only, not current-open/current-fixed certification'))
ids=[x['id'] for x in rows];duplicates=[k for k,v in Counter(ids).items() if v>1];assert not duplicates,duplicates
v=dict(createdUTC=datetime.now(timezone.utc).isoformat(),scope='Canonical formal finding records from audit rounds1–42 only; excludes candidates/related and nested copies/archives. Source priorities and dated dispositions preserved, no new issues or updated runtime status inferred.',baseline=baseline,sourceDocuments=sources,counts=dict(formalRecordRows=len(rows),uniqueIds=len(set(ids)),byPriority=dict(sorted(Counter(x['priority'] for x in rows).items())),rounds=42),findings=rows,limitations=['Historical records include items later source-addressed elsewhere; this is not an inventory of currently-open bugs.','Exact ID uniqueness checked; causes are not newly re-reviewed or re-deduplicated here. Canonical original classification controls.','No product source/test/fixture/runtime reading or execution is added by this metadata index.'])
(O/'recorded-findings-catalog.json').write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(counts=v['counts'],titles=[dict(id=x['id'],priority=x['priority'],title=x['title']) for x in rows]),ensure_ascii=False))
