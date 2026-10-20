from pathlib import Path
import json,hashlib,datetime
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round148-subagent-continuation')
def sha(b):return hashlib.sha256(b).hexdigest()
def write(name,v):(OUT/name).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def pin(path):
 b=(ROOT/path).read_bytes();return dict(path=path,bytes=len(b),lines=len(b.splitlines()),sha256=sha(b))
before=json.loads((OUT/'initial-pins.json').read_text())['files']+json.loads((OUT/'support-before-pins.json').read_text())
checks=[]
for row in before:
 now=pin(row['path']);assert now['sha256']==row['sha256'];checks.append(dict(path=row['path'],beforeSha256=row['sha256'],afterSha256=now['sha256'],same=True))
displayed={'packages/core/src/session/subagent-continuation.ts':[[1,63]]}
for n in (2,3,4):
 for path,ranges in json.loads((OUT/f'source-read-0{n}-ranges.json').read_text()):displayed.setdefault(path,[]).extend(ranges)
def union(ranges):
 result=[]
 for a,b in sorted(ranges):
  if result and a<=result[-1][1]+1:result[-1][1]=max(result[-1][1],b)
  else:result.append([a,b])
 return result
selected={
 'packages/core/src/session/subagent-continuation.ts':[[1,63]],
 'packages/core/src/types.ts':[[8,23]],
 'packages/core/src/tool-system/builtin/agent.ts':[[403,467],[844,861],[880,900],[1463,1515],[1525,1569]],
 'packages/core/src/session/session-manager.ts':[[736,769],[792,817],[1043,1053]],
 'packages/core/src/engine/engine.ts':[[2616,2648]],
 'packages/core/src/engine/subagent-spawner.ts':[[328,375],[414,430]],
 'packages/core/src/engine/run-session-open.ts':[[61,69],[98,115],[195,207]],
}
rows=[]
for path,ranges in selected.items():
 ranges=union(ranges);disp=union(displayed[path]);r=pin(path)
 for a,b in ranges:assert any(x<=a<=b<=y for x,y in disp),(path,a,b)
 r.update(coverage='full' if path.endswith('/subagent-continuation.ts') else 'selected',selectedLineRanges=ranges,bodyDisplayedLineRanges=disp,semanticLines=sum(b-a+1 for a,b in ranges),bodyDisplayedLines=sum(b-a+1 for a,b in disp),beforeBodyOrLineNavigation=True,scope='Ordinary stored continuation fields from Agent creation through state snapshot and terminal AgentSendInput restore. Authority, sandbox, process, live-writer concurrency, hooks, filesystem atomicity and provider execution are outside this finite conclusion.',overlap='Parser leaf has same-SHA full original round19 scope. Supporting paths retain existing selected/unknown coverage metadata without inferring unread or first reading; no new unique-file coverage union.')
 rows.append(r)
nav=[]
for b in before:
 if b['path'] not in selected:
  r=pin(b['path']);r.update(coverage='navigation-only',selectedLineRanges=[],scope='Filename/path pin and matching continuation symbol line navigation only, no surrounding body read.');nav.append(r)
hist=[]
for path,pointer in [('docs/audit-2026-10-17-round19/evidence/root-source-manifest.json','/files/5'),('docs/audit-2026-10-17-round19/source-manifest.json','/files/24'),('docs/audit-2026-10-17-round55/evidence/coverage-current/unified-current-index.json','/files: only nine supporting paths')]:
 r=pin(path);r.update(coverage='selected-metadata',jsonPointers=[pointer],pinTiming='Root binds current bytes after the reported selected metadata read; not fabricated as a before-read metadata pin.');hist.append(r)
instr=[]
for path in ['AGENTS.md','CODESHELL.md']:
 r=pin(path);r.update(coverage='hash-only-instruction-carry-forward',scope='Previously read instructions reused after matching SHA; CODESHELL also reread in primary during user status response, not new product coverage.');instr.append(r)
manifest=dict(files=rows,navigationOnly=nav,historicalReportReads=hist,instructionCarryForward=instr,sourceSemanticReads=len(rows),productExecution=0,history=dict(batch=str(OUT/'history-batch.json'),historyFiles=6010,jsonValueScalarsVisited=4291442,target='packages/core/src/session/subagent-continuation.ts',count=56,cap=100,machineNavigationOnly=True),scope='Finite ordinary creation/storage/terminal restore field chain; no authority metadata or real session experiment, no test read/run. All old failure directions remain skipped.')
write('source-manifest.json',manifest)
write('classification.json',dict(formal=[],candidates=[],related=[],counts=dict(formal=0,candidates=0,related=0),finiteScope=manifest['scope']))
write('ending-checks.json',dict(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),checks=checks,allSame=True,productExecution=0,sourceReadersFrozen=True))
write('diagnostics.json',dict(productRuns=0,productReruns=0,metadata=[dict(operation='Root symbol navigation wrapper',exitCode=0,diagnostic='Python emitted SyntaxWarning for non-raw regex escape \\. on stderr; source navigation completed0. Original warning is in tool transcript; it was not captured into a separate raw stderr file. No product attempt occurred and no command rerun was used to hide it.')],failedProductDirectionsReopened=[]))
summary=dict(formal=0,candidates=0,related=0,semanticFiles=len(rows),semanticLines=sum(r['semanticLines'] for r in rows),displayedLines=sum(r['bodyDisplayedLines'] for r in rows),navigationOnlyFiles=len(nav),testsRead=0,productRuns=0,historyFiles=6010,jsonValueScalarsVisited=4291442,targetMatches=56)
write('checks.json',summary)
(OUT/'report.md').write_text('''# Root148：子代理续办普通字段链

有限结论 **0正式、0候选、0新关联**。原round19 parser同SHA全文记录已亲核，当前重读保留全部重叠，不称首次、未读或新唯一覆盖。

Agent正常创建在403–467冻结parent/type/name/description/maxTurns/model/allowlists/sandbox/prompt/readOnly字段；spawner414–430把同一continuation传给run options，open61–69校验、195–207传入SessionManager.create，manager736–766重建detached值并置入state，792–817交给既有state writer。这里只核普通字段传递，不认证writer原子性、权限或实际磁盘恢复。

终态AgentSendInput在1463–1515优先取registry snapshot，否则经spawner→manager1043–1053读取已存continuation；1525–1569由原scope重建overrides，runSync880–900直接使用continuation.readOnlySession并继续传同snapshot。open98–115校验已有snapshot一致性。当前未建立“重启后重新解析已改角色而丢失原字段”的普通反例。运行中的direction route、writer lease、sandbox与Host authority只是相邻显示，均不纳入本有限结论。

[源清单](source-manifest.json)逐路径区分语义选段、完整body显示及仅符号导航。types仅接口字段；agent背景完成/hook/status等相邻显示不认证。没有产品/helper/import/fixture/test/模型/会话/native/网络执行，也没有测试声明阅读；旧失败动态方向不恢复。

[共享历史batch](history-batch.json)扫描6010历史MD/JSON及4291442递归JSON值scalar，排formal59+、包括archive，target56命中全部显示、cap100，parse errors为空。这是机器导航，不等于全历史语义阅读。亲读原round19两个manifest对象和旧55覆盖索引九路径对象，metadata pin晚于选段阅读的时序如实保留。源初始pin均早于正文/行号导航，结束全同。[结束核对](ending-checks.json)及[检查](checks.json)不证明全子系统正确。

Root导航wrapper一次Python invalid-escape SyntaxWarning见工具原转录，命令exit0；未独立捕获原warning文件，不伪造。它不是产品失败或产品重跑。[诊断](diagnostics.json)。本包现已冻结。
''')
files=[]
for p in sorted(OUT.rglob('*')):
 if p.is_file() and p.name!='artifact-receipt.json':
  b=p.read_bytes();files.append(dict(path=str(p.relative_to(OUT)),bytes=len(b),sha256=sha(b)))
write('artifact-receipt.json',dict(files=files,excludesSelf=True,productExecution=0,frozen=True))
print(json.dumps(summary,ensure_ascii=False))
for name in ['report.md','source-manifest.json','artifact-receipt.json']:
 b=(OUT/name).read_bytes();print(name,len(b),sha(b))
