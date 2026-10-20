from pathlib import Path
import json,hashlib,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round153-release-audit-config')
def sha(b):return hashlib.sha256(b).hexdigest()
def write(n,v):(D/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def pin(p):
 b=(R/p).read_bytes();return dict(path=p,bytes=len(b),lines=len(b.splitlines()),sha256=sha(b))
initial=json.loads((D/'initial-pins.json').read_text())['files']+json.loads((D/'support-before-pins.json').read_text())['files'];ending=[]
for old in initial:
 cur=pin(old['path']);assert cur['sha256']==old['sha256'];ending.append(dict(path=old['path'],beforeSha256=old['sha256'],afterSha256=cur['sha256'],same=True))
selections={'scripts/package-release-audit-config.ts':[[1,297]],'scripts/package-release-smoke.ts':[[112,145],[335,349],[391,419],[422,442]],'scripts/publish-release-packages.ts':[[388,407],[414,432],[435,447]]}
displays={'scripts/package-release-audit-config.ts':[[1,297]],'scripts/package-release-smoke.ts':[[101,152],[330,356],[388,442]],'scripts/publish-release-packages.ts':[[386,448]]}
files=[]
for p,ranges in selections.items():
 row=pin(p);row.update(coverage='full' if p.endswith('/package-release-audit-config.ts') else 'selected',selectedLineRanges=ranges,bodyDisplayedLineRanges=displays[p],semanticLines=sum(b-a+1 for a,b in ranges),displayedLines=sum(b-a+1 for a,b in displays[p]),beforeBodyOrLineNavigation=True,scope='Ordinary release roster/export classification and direct consumer field selection. No build, package installation, publishing, subprocess, filesystem cleanup or security mechanism certified.',overlap='R6 report names this direction without explicit per-file full range; R24 config selected45–105 is retained as overlap. No first/unread/new-unique claim.');files.append(row)
for m in json.loads((D/'manifest-projection.json').read_text()):
 row=pin(m['path']);row.update(coverage='selected-metadata',selectedLineRanges=[],jsonPointers=['/'+x for x in m['jsonPointers']],semanticLines=None,beforeBodyOrLineNavigation=True,scope='Only displayed manifest property values, not whole JSON line coverage or installed-package outcome.');files.append(row)
hashes=[]
for old in initial[:3]:
 row=pin(old['path']);row.update(coverage='hash-only',scope='Shared query target pinned; body review delegated150–152.');hashes.append(row)
for p in ['AGENTS.md','CODESHELL.md']:
 row=pin(p);row.update(coverage='hash-only-instruction-carry-forward',scope='Prior actual instruction read reused after same-SHA check, not new product coverage.');hashes.append(row)
hist=[]
for row in json.loads((D/'prior-canonical-gate.json').read_text()):
 p=row['path'];cur=pin(p);assert cur['sha256']==row['sha256'];cur.update(coverage='selected-metadata',selectedObjects=[row['selectedObject']],pinTiming='Metadata hash captured with selected-object read, not asserted before read.');hist.append(cur)
row=pin('docs/audit-2026-10-17-round6/root-package.md');row.update(coverage='selected-metadata',selectedLineRanges=[[1,row['lines']]],pinTiming='Late after the actual report read; no initial metadata pin invented.');hist.append(row)
write('source-manifest.json',dict(files=files,hashOnlyFiles=hashes,historicalReportReads=hist,scope='Release-config ordinary field chain only. Actual root/core/web manifests selected, not all manifests or every release/platform.',executions=dict(product=0,helper=0,build=0,test=0,install=0,publish=0,network=0,Git=0),newUniqueCoverageClaim=False))
write('ending-checks.json',dict(checks=ending,allSame=True,atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),productExecution=0))
write('classification.json',dict(formal=[],candidates=[],related=[],finiteNegative=True,scope='No ordinary current selected producer-to-consumer mismatch established.'))
write('diagnostics.json',dict(productAttempts=0,metadataFailures=[],outputTruncations=[],note='No product/helper/build/test/install/publish invocation. R6 old pass numbers remain historical only.'))
(D/'report.md').write_text('''# Root153：发布清单与export分类普通字段链

有限 **0正式、0候选、0新关联**。目标297行仅核静态配置与普通值验证，不等于整条发布链通过。[源清单](source-manifest.json)保留准确范围与JSON pointers，3份manifest仅所示属性，不当整文件行覆盖。

先亲读原R24 root-package-prep /sources/132，config当前同SHA、原scope只有45–105 release roster；R6 /files/90仅hash、root-package原报告虽列相关脚本但未给本目标全文范围，不能升级旧full或宣称首次未读。R6旧17pass不借为本批运行结果，A11任务分支打标签与旧watch静态候选均不重报。[原gate](prior-canonical-gate.json)。

当前config明确10public/5private，private仅版本同步。validatePublicReleaseOrder检查实际public列表中runtime/optional/peer依赖前置及private依赖；collectPublishEntries按non-code/runtime-excluded分别投影typeImport/runtimeImport，不把两种排除混同。validatePublishManifest对root、dist targets、import/types、non-code自指与bin做静态字段检查。

真实smoke112–145对同一配置加载manifest并执行validator；335–349/391–419只向type consumer投影typeImport，422–442只向runtime consumer投影runtimeImport。publish388–407/414–432沿相同public顺序加载、检查order/versions并生成commands，435–447按同index取definition。这里只核传递与字段选择，未执行这些函数或认证发布应答/远端接受/rollback。

实际root/core/web manifest所选exports与当前规则一致：web package.json是non-code，core CLI子路径禁止runtime smoke但仍保留类型路径；root bin/exports由别的build包定向复核。未建立正常当前输入下被遗漏或错误分类的新反例。没有用任意非法manifest/null/缺失dist或未知平台情况制造formal。

[共享batch](history-batch.json)纳冻59排60+：6126历史MD/JSON、4322397递归value scalar、0parse错，含archive。四目标109/34/33/57命中，cap100；build-meta只前100，其余全保存。这是机器导航，不是全史语义阅读。Root本目标57命中仅用于有限canonical定位，不由没有命中认新颖。

产品/helper/import/build/test/install/publish/native/network与Git执行均0，无新失败实验，既有失败方向仍跳过。所有源初始pin早于body/行号导航，结束同SHA。[结束](ending-checks.json)、[诊断](diagnostics.json)、[分类](classification.json)与[自排除收据](artifact-receipt.json)保存。本包冻结，有限0不证明全部发布合同正确。
''')
rows=[]
for p in sorted(D.rglob('*')):
 if p.is_file() and p.name!='artifact-receipt.json':
  b=p.read_bytes();rows.append(dict(path=str(p.relative_to(D)),bytes=len(b),sha256=sha(b)))
write('artifact-receipt.json',dict(files=rows,excludesSelf=True,frozen=True,productExecution=0))
print(json.dumps(dict(files=len(rows)+1,sourceCodeSemanticLines=sum(x.get('semanticLines') or 0 for x in files),displayedCodeLines=sum(x.get('displayedLines') or 0 for x in files),manifestObjects=3,formal=0)))
for p in ['report.md','source-manifest.json','artifact-receipt.json']:
 b=(D/p).read_bytes();print(p,len(b),sha(b))
