from pathlib import Path
from datetime import datetime,timezone
import json,hashlib
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round110-parse-task')
def sha(b):return hashlib.sha256(b).hexdigest()
def put(n,j):(D/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
x=json.loads((D/'selection-initial-pins.json').read_text())['files'][0];b=(R/x['path']).read_bytes();assert sha(b)==x['sha256'];x.update(coverage='hash-only; excluded before current body by same-SHA explicit old full',selectedLineRanges=[],semanticLineCount=0,endingSha256=sha(b))
mr='docs/audit-2026-10-17-round32/evidence/taskparse-source-manifest.json';md='docs/audit-2026-10-17-round32/taskparse-report.md';m=json.loads((R/mr).read_text());row=m['files'][0];assert row['sha256']==x['sha256'] and row['coverage']=='full' and row['bytes']==x['bytes'];text=(R/md).read_text().splitlines();put('canonical-gate-read.json',dict(manifest=mr,baseline=m['baseline'],pointer='/files/0',row=row,report=md,selectedLineRanges=[[1,15]],text='\n'.join(f'{i}: {text[i-1]}' for i in range(1,16)),targetOnly=True,consumerFullActivated=False))
h=json.loads((D/'history.json').read_text());assert all((R/a['path']).is_file() and sha((R/a['path']).read_bytes())==a['sha256'] for a in h['inventory']);put('ending-checks.json',dict(sourceSame=True,originalHistoryFiles=5150,changed=[],productRuns=0))
hr=[]
for p,rr in [(mr,[]),(md,[[1,15]])]:
 b=(R/p).read_bytes();hr.append(dict(path=p,bytes=len(b),sha256=sha(b),coverage='selected metadata only',selectedLineRanges=rr,scope='Canonical full-row qualifier and original MD3/5/9/15 only; not product source.'))
put('source-manifest.json',dict(rootReportedReadBaseline='524c0827a480132119b637aa87e16f0eab9895f3',files=[],hashOnlyFiles=[x],historicalReportReads=hr,targetOldFullSourceExclusionOnly=True,consumerFullSeparatelyActivated=False,productRuns=0,globalCoverageUpdated=False))
(D/'report.md').write_text('''# Root110：parse-task旧全文门槛\n\n有限0新formal/0candidate/0related。当前parse-task190行/7206B，SHAe93cf2d…在正文/行导航前固定；本批产品正文/测试声明/运行均0。原R32taskparse-source-manifest /files/0明确full、1–190和同SHA；taskparse-report3/5绑定4be4016…版本及完整190行，7/9/15保留普通producer与旧IMAGE-R15-C1排除、0产品运行边界。因此仅目标在正文前排除重复，不额外激活消费者全文、不重开旧不支持wire反例。\n\n[原canonical字段与MD选段](canonical-gate-read.json)、[pin](selection-initial-pins.json)、[范围](source-manifest.json)。原46个精确路径对象的[compact限定](coverage-read.compact.json)完整显示；其派生hash、claims和历史copies不当成新语义。5150=1489MD+3661JSON，2430509strings/3611347scalars，path796/SHA78/宽task原因1118；各cap60窗口未逐一语义读完，不当不存在旧bug证明。纳冻结52、排53+，含archive，递归JSON值不查keys。\n\n[历史扫描](history.json)、[方法](scan-history.py)、[首退出](history-first-exit.json)、[结束](ending-checks.json)保留；原5150历史字节和target同，Root53新文件不倒填。没有运行产品/helper/fixture/test/React/DOM/timer/model/network/native/Git，无metadata错误或截断，只有filename候选导航不声称全仓未读。目标排除完成，全仓审查继续，Root另选ordinary源。\n''')
rows=[]
for p in sorted(D.rglob('*')):
 if p.is_file() and p.name!='author-receipt.json':
  b=p.read_bytes();rows.append(dict(path=p.relative_to(D).as_posix(),bytes=len(b),sha256=sha(b)))
put('author-receipt.json',dict(atUTC=datetime.now(timezone.utc).isoformat(),files=rows,selfExcluded=True,productRuns=0));print(json.dumps(dict(files=len(rows)+1,targetOnlyOldFull=True,productSemanticLines=0)))
