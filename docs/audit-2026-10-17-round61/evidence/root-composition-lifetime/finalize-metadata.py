from pathlib import Path
import json,hashlib,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round157-composition-lifetime')
def sha(b):return hashlib.sha256(b).hexdigest()
def write(n,v):(D/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def pin(p):
 b=(R/p).read_bytes();return dict(path=p,bytes=len(b),lines=len(b.splitlines()),sha256=sha(b))
initial=json.loads((D/'initial-pins.json').read_text())['files']+json.loads((D/'support-before-pins.json').read_text())['files'];checks=[]
for old in initial:
 new=pin(old['path']);assert new['sha256']==old['sha256'];checks.append(dict(path=old['path'],beforeSha256=old['sha256'],afterSha256=new['sha256'],same=True))
selected={'packages/core/src/composition/lifetime.ts':[[1,95]],'packages/core/src/composition/activation.ts':[[1,146]],'packages/core/src/engine/engine.ts':[[647,649],[818,840],[844,860],[863,884],[1796,1805],[4004,4028]],'packages/core/src/engine/runtime.ts':[[61,64],[72,78],[141,158]],'packages/core/src/composition/types.ts':[[44,51],[62,80]]}
display={'packages/core/src/composition/lifetime.ts':[[1,95]],'packages/core/src/composition/activation.ts':[[1,146]],'packages/core/src/engine/engine.ts':[[640,660],[800,890],[1786,1815],[1878,1898],[4004,4050]],'packages/core/src/engine/runtime.ts':[[60,84],[115,159]],'packages/core/src/composition/types.ts':[[42,84]]}
files=[]
for p,ranges in selected.items():
 row=pin(p);row.update(coverage='full' if '/composition/' in p and not p.endswith('/types.ts') else 'selected',selectedLineRanges=ranges,bodyDisplayedLineRanges=display[p],semanticLines=sum(b-a+1 for a,b in ranges),bodyDisplayedLines=sum(b-a+1 for a,b in display[p]),beforeBodyOrLineNavigation=True,scope='Ordinary scope ownership/activation result registration and direct Engine/runtime scheduling fields. Does not certify real hooks, MCP/native processes, permission, provider, cross-run concurrency or shutdown of arbitrary custom factories.',overlap='Original R11 root rows selected; lifetime original hooks/files11 same-SHA full explicitly retained. No first/unread/new-unique coverage claim.');files.append(row)
hashonly=[]
for old in initial[:4]:
 row=pin(old['path']);row.update(coverage='hash-only',scope='Shared path/SHA history target; semantic review delegated155/156.');hashonly.append(row)
for p in ['AGENTS.md','CODESHELL.md']:
 row=pin(p);row.update(coverage='hash-only-instruction-carry-forward',scope='Prior actual read reused after same-SHA check, not product semantic reading.');hashonly.append(row)
hist=[]
for p,pointers in [('docs/audit-2026-10-17-round11/evidence/root-source-manifest.json',['/files/9','/files/10']),('docs/audit-2026-10-17-round11/evidence/hooks-source-manifest.json',['/files/11']),('docs/audit-2026-10-17-round11/composition.md',[])]:
 row=pin(p);row.update(coverage='selected-metadata',jsonPointers=pointers,pinTiming='Recorded with/after actual selected metadata read; not invented before-read pin.');hist.append(row)
write('source-manifest.json',dict(files=files,hashOnlyFiles=hashonly,historicalReportReads=hist,scope='Finite ordinary lifetime ownership/data chain; full static leaf labels remain purpose-bound, no executed lifecycle mechanism.',productExecution=0))
write('ending-checks.json',dict(checks=checks,allSame=True,atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),productExecution=0))
write('classification.json',dict(formal=[],candidates=[],related=[],finiteNegative=True))
write('diagnostics.json',dict(productAttempts=0,metadataNonzeroCommands=[],metadataWarnings=[dict(operation='dispose symbol navigation wrapper',exitCode=0,observation='Python emitted invalid-escape SyntaxWarning for non-raw regex parenthesis; original warning is in tool transcript only, subprocess stdout/stderr files do not contain wrapper warning. No product operation or rerun.')],rangeMetadata=dict(requested='source-read-03-requested-ranges.json',actual='source-read-03-ranges.json',note='Display helper clamped runtime requested end170 to actual EOF159; actual headers already159, requested range bytes preserved before correcting actual-range metadata. No source or execution rerun.')))
(D/'report.md').write_text('''# Root157：composition lifetime普通所有权链

有限 **0正式、0候选、0新关联**。原R11 root manifest两个对象只selected，hooks `/files/11`明确lifetime当前同SHA full（onceDispose实际由HookRegistry导入）；当前重读保留旧全文重叠，不称首次或新唯一覆盖。原composition报告说明activation/lifetime只读、旧9pass没有运行实际资源激活；本批不借旧通过数。[原gate](prior-canonical-gate.json)。

lifetime.dispose先冻结同一disposal promise，按子scope及逆序资源列表排空，每个同步/异步失败均收集后继续，最后detach并汇总错误。ownActivationResult对已关闭scope的late返回值直接release；createPrivateServices每module一项privateService（types字段80）以moduleId注册，失败/abort先rollback，所有pending settled后合并错误，late install走release，不把未安装值写回map。

实际Engine647–649创建engine child，818–840依次启动private services→activators并保存同moduleReady；moduleServiceHost848–860已给冻结普通对象，不从activationContext再次freeze推断改变可变caller。session863–884先登记scope和删除回调，再await服务，1796–1805在成功后创建run scope与合并service值。runtime ownEngine72–78返回的只是删除close callback的onceDispose，不是递归调用同一个engine.dispose；close141–158先await engines，再dispose host scope。Engine4004–4028先abort、初始化期间先unwind，随后await run/moduleReady并finally dispose同scope。这里只核实际调用顺序与数据/所有权表达，不认证任意async factory必定终止、真实并发或native资源释放。

当前未建立普通内建producer下的新注册/释放遗漏反例；没有用自持self-dispose、不正常module key或任意永不settle factory制造bug。权限、MCP、sandbox和hot-reload等相邻显示不纳入机制结论。[源清单](source-manifest.json)5产品397语义行/564显示行：2full静态叶+3selected；0测试声明或运行。

[共享batch](history-batch.json)纳冻60排61+、含archive：6244历史MD/JSON、4350476递归JSON value scalar、0parse错误。六目标93/177/132/25/78/65，cap100，service/project只前100；机器访问不是全史语义阅读。Root只亲读原R11指定对象/报告，不由无命中认证新颖。

产品/helper/import/fixture/test/真实Host/会话/clock/native/network与本包Git执行均0，旧失败实验仍跳过。一次metadata wrapper invalid-escape warning exit0只在工具转录，不伪造原stderr；runtime显示请求170由helper实际clamp至EOF159，原requested表与正确actual表均保留。见[诊断](diagnostics.json)、[结束](ending-checks.json)、[分类](classification.json)、[自排除收据](artifact-receipt.json)。本包现冻结。
''')
rows=[]
for p in sorted(D.rglob('*')):
 if p.is_file() and p.name!='artifact-receipt.json':
  b=p.read_bytes();rows.append(dict(path=str(p.relative_to(D)),bytes=len(b),sha256=sha(b)))
write('artifact-receipt.json',dict(files=rows,excludesSelf=True,frozen=True,productExecution=0))
print(json.dumps(dict(files=len(rows)+1,semanticFiles=len(files),semanticLines=sum(r['semanticLines'] for r in files),displayedLines=sum(r['bodyDisplayedLines'] for r in files),formal=0)))
for p in ['report.md','source-manifest.json','artifact-receipt.json']:
 b=(D/p).read_bytes();print(p,len(b),sha(b))
