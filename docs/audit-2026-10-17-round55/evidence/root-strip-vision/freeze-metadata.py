from pathlib import Path
import json,hashlib,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round127-strip-vision')
def sha(b):return hashlib.sha256(b).hexdigest()
def w(n,j):(D/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
pins=json.loads((D/'initial-pins.json').read_text())['files']+json.loads((D/'consumer-initial-pins.json').read_text())['files'];by={r['path']:r for r in pins}
specs=[('packages/core/src/llm/strip-vision.ts','full',[[1,107]],[[1,107]]),('packages/core/src/llm/providers/openai.ts','selected',[[1036,1040]],[[1028,1055]]),('packages/core/src/llm/providers/anthropic.ts','selected',[[420,426]],[[414,442]]),('packages/core/src/types.ts','selected',[[27,50]],[[24,50]]),('packages/core/src/llm/strip-vision.test.ts','selected',[[13,36],[51,111]],[[13,36],[51,111]])]
rows=[];excerpts=[]
for p,cov,sem,shown in specs:
 r=by[p];b=(R/p).read_bytes();assert sha(b)==r['sha256'];lines=b.decode().splitlines();rows.append(dict(path=p,bytes=len(b),lines=len(lines),sha256=r['sha256'],coverage=cov,selectedLineRanges=sem,bodyDisplayedLineRanges=shown,semanticLines=sum(z-a+1 for a,z in sem),bodyDisplayedLines=sum(z-a+1 for a,z in shown),beforeBodyOrLineNavigation=True,scope='Pure ordinary direct image and immediate tool_result block replacement, identity-preserving contract and exact buildMessages call boundary. Not all provider serialization, capability resolution or runtime behavior. Test declarations only0execution.',overlap='Archive already describes normal same-function path. Current read not first/unread or unique new coverage.'))
 excerpts.append(dict(path=p,sha256=r['sha256'],capturedAfterActualDisplay=True,blocks=[dict(start=a,end=z,lines=[dict(line=n,text=lines[n-1]) for n in range(a,z+1)]) for a,z in shown]))
w('source-excerpts.json',dict(files=excerpts,productExecution=0));w('source-manifest.json',dict(files=rows,totals=dict(fullFiles=1,selectedFiles=4,productSemanticLines=143,testDeclarationLines=85,bodyDisplayedLines=276),rootReportedBaseline='00c046367769349c1f5413e74c993b2c19ce8337',productExecution=0))
batch=json.loads((D/'history-batch.json').read_text());changed=[];missing=[]
for r in batch['inventory']:
 p=R/r['path']
 if not p.is_file():missing.append(r['path'])
 else:
  b=p.read_bytes()
  if len(b)!=r['bytes'] or sha(b)!=r['sha256']:changed.append(r['path'])
assert not changed and not missing
w('ending-checks.json',dict(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),sourcePins=[dict(path=r['path'],sha256=r['sha256'],same=sha((R/r['path']).read_bytes())==r['sha256']) for r in pins],historyFiles=len(batch['inventory']),changed=changed,missing=missing,productRuns=0));assert all(sha((R/r['path']).read_bytes())==r['sha256'] for r in pins)
w('classification.json',dict(formal=[],candidates=[],related=[],counterevidence=['Target returns original messages on supported/no-image cases; replaces images through fresh content arrays/new affected messages, leaves original block content intact.','Immediate nested tool_result image removal spreads original block properties and preserves nonimage child text/tool-use id/error metadata.','Both current provider buildMessages boundaries call strip with capability flag on outgoing local parameter.','Single placeholder per message/content list is explicit contract; no unsupported nonconsecutive-position bug inferred.'],excludedOldCauses=['Archived view-image providerKind fallback disagreement','Legacy forced image_url cast compatibility','Archived data-URL collector/converter incompatibility'],unknown=['No arbitrary deeper nested tool_result DTO used as actual production counterexample','Full providers, capability rules and account/network behavior not reviewed here']))
w('validation.json',dict(productAttempts=0,testsExecuted=0,helperExecuted=0,nativeNetworkModelExecuted=0,staticTestDeclarationLines=85,scope='No imports or product execution; metadata stdout/stderr/exit retained, first scan exit0.'))
(D/'report.md').write_text('''# Root127：非视觉模型历史图片降级的普通内容保留

有限结论0新增正式问题、0候选、0新增关联。[初始pin](initial-pins.json)在正文前固定strip-vision107行4054B SHAd4c2…；[历史batch](history-batch.json)同5433范围纳54排55+，path/SHA59命中全保存、0parse错。先实际读前30命中中的有限非coverage行，原archive302–346明确已审正常strip路径、providerKind/legacy image_url/dataURL旧因。本轮保留该重叠，不以缺少SHA全文row声称从未读过，也不将旧archive缺陷重报。

围绕“正常图片/文字与tool_result混合时是否丢文字或修改原历史”亲读完整107行：supported/no-image返回原引用；非视觉模式只新建受影响message/content数组，保留文本与其他block；立即嵌套tool_result时spread原block再替换子content，tool_use_id/is_error等保留。多个图片单placeholder是明确合同，未凭任意更深嵌套或forced image_url DTO造真实入口。

真实OpenAI buildMessages1040、Anthropic buildMessages426把outgoing局部messages经strip处理；仅此调用边界，不认证两provider完整序列化/能力解析/外部模型。types27–50明确普通ContentBlock与Message形状。既有测试13–36、51–111声明支持vision identity、内容保留、原输入不变、单placeholder和直接nested tool_result图片，85行只声明未运行，不借archive旧测试当本轮pass。

[范围清单](source-manifest.json)1完整产品+4selected（含1测试），143产品语义/85测试声明，正文显示276行，邻接provider reasoning/cache prose不纳语义；完整provider1524/593行和types1333行未读完。[consumer pins](consumer-initial-pins.json)早于行导航，[摘录](source-excerpts.json)实际显示后捕获。Root125/126/127均同作者，不说成独立复核。[结束](ending-checks.json)5源/测试pins与原5433历史成员字节同；所有产品/helper/import/fixture/test/UI/timer/模型/网络/native执行0。无产品修复，完整全仓覆盖未重算。
''')
art=[]
for p in sorted(D.iterdir()):
 if p.is_file() and p.name!='author-receipt.json':
  b=p.read_bytes();art.append(dict(path=p.name,bytes=len(b),sha256=sha(b)))
w('author-receipt.json',dict(frozen=True,files=art,scope='Self-excluded exact finite static evidence, product execution0.'))
print(json.dumps(dict(files=len(art)+1,receipt=len(art),formal=0)))
