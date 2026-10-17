from pathlib import Path
import json, hashlib, re, datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
O=R/'docs/audit-2026-10-17-round57'; E=O/'evidence'
def sha(b): return hashlib.sha256(b).hexdigest()
def wr(p,j): p.write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
c=json.loads((O/'coverage.json').read_text()); plan=json.loads((E/'integration-plan.json').read_text())
old=json.loads((R/'docs/audit-2026-10-17-round53/recorded-findings-catalog.json').read_text())
catalog=json.loads(json.dumps(old)); formal=json.loads((O/'findings.json').read_text())['findings'][0]
catalog.update(createdUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='Formal historical discoveries through57; not current-open/current-fixed inventory.',baseline=plan['baseline'],predecessorCatalog='docs/audit-2026-10-17-round53/recorded-findings-catalog.json')
catalog['findings'].append(dict(id=formal['id'],priority=formal['severity'],title=formal['title'],sourceRound=57,canonicalFindings='docs/audit-2026-10-17-round57/findings.json',baseline=plan['baseline'],originalStatus='static-confirmed; runtime not validated',originalFixedFlag=False,originalMainSourceDisposition=None,statusInterpretation='Dated discovery only, not current-unfixed/runtime certification'))
catalog['counts']=dict(formalRecordRows=117,uniqueIds=117,byPriority=dict(P2=44,P3=73),rounds=57)
b=(O/'findings.json').read_bytes()
catalog['sourceDocuments'].append(dict(round=57,path='docs/audit-2026-10-17-round57/findings.json',bytes=len(b),sha256=sha(b),originalReportedCount=1,baselineBlobMatches=None,note='New task-owned evidence artifact, not product baseline Git blob.'))
assert catalog['findings'][:-1]==old['findings']; wr(O/'recorded-findings-catalog.json',catalog)
lines=['# 全部117项正式历史问题与未完成范围','','累计117项：44P2、73P3。本轮新增PET-R57-01，原116机器对象原样保留；STATIC-R135-C1仍为候选，不计正式。117不是当前未修复数，部分旧项已有源码处理记录而未运行复验。','','最新可靠语义台账仍为旧45同SHA迁移的4643路径：304完整范围、168部分、4171无法确认；4339不能标full不是精确未读或剩余量。46–53仍DEFERRED_UNPARSED，54–57未统一回填；本轮增加1个审查fixture，当前同过滤库存4644路径，新增证据文件不算产品全文审查。非TS/TSX与完整运行机制不在分母。详见[覆盖报告](../audit-2026-10-17-round55/evidence/coverage-current/report.md)与[字节绑定](evidence/coverage-snapshot-current-binding.json)。','','| ID | 级别 | 历史问题 |','| --- | --- | --- |']
for f in catalog['findings']:
 target='findings.json' if f['sourceRound']==57 else '/Users/admin/Documents/个人学习/代码学习/codeshell/'+f['canonicalFindings']
 title=re.sub(r'^\[[^]]*\]\s*','',f['title']).replace('|','&#124;')
 lines.append('| ['+f['id']+']('+target+') | '+f['priority']+' | '+title+' |')
lines.extend(['','[原源码处理说明](recorded-findings-catalog.json)保留MARKETPLACE-R37-01、MCP-R38-01、MCP-R39-01正式44处理和WEB-R8-01旧并发处理记录，不作为完整当前修复状态认证。触发、反证与运行界限以原报告为准。'])
(O/'ALL-ISSUES.md').write_text('\n'.join(lines)+'\n')
(O/'README.md').write_text(f'''# 正式57：Pet话题收尾、Panel任务生命周期、会话标题与静态路径

新增 **1项静态确认P3：PET-R57-01**，保留 **1候选STATIC-R135-C1**，0新增关联计数。历史正式问题合计 **117（44P2、73P3）**，不是当前未修复数。[完整列表](ALL-ISSUES.md)与[机器目录](recorded-findings-catalog.json)保留原116对象不变。

Pet在已有正常可提取内容、自动提取开启、合法resume follow-up跨过默认12h空闲间隔并成功运行时，以自动注入消息H作为新话题边界；closure reader过滤H，刚关闭旧段的结束锚点缺失，立即return null，跳过journal和自动记忆提取。下一段以H为起点时也失败；后续真实用户新段可以恢复，旧已成功记录不回滚。独立136补查普通assistant writer与实际Facade wiring，没有发现替代H锚点。只静态复核，未运行Pet；不声称原始消息丢失或独立Core span/context归档失败。[正式触发、反证与范围](findings.json)。132/136原包仍保留同一候选，Root只晋升一次。

移动静态资源用一次guarded实际handler单测验证：普通文件200、存在空格文件的编码URL404、真实缺失404，**3pass/8expect/0fail，0重跑**。只用临时文件和Writable响应sink，无HTTP server/socket/proxy/模型/worker/Core Engine/真实账户或业务网络。独立137查到当前4个public资源和所读实际URL均为ASCII；208 filename库存不是完整依赖/最终bundle。尚未建立当前默认产品资源触发，保持候选，不能把测试通过当生产故障或Pet运行验证。[首stdout](evidence/root-static-files/static-path-first.stdout)、[首stderr](evidence/root-static-files/static-path-first.stderr)、[首退出](evidence/root-static-files/static-path-first-exit.json)、[fixture](evidence/static-path.test.ts)。

| 有限包 | 结论与边界 |
| --- | --- |
| [132 Pet作者](evidence/pet-topic/report.md) | topic/closure旧full重叠保留；2152产品范围行、74测试声明，原候选不倒写 |
| [136独立Pet](evidence/pet-closure-review/report.md) | 1103产品selected、111声明；补实际assistant writer接线，同一问题不双计 |
| [133 Panel任务](evidence/tool-jobs/report.md) | 1265产品、61声明；追真实executor/process退出与cancel结算，旧R30持久化失败排除，native/权限/custody未认证 |
| [134会话标题](evidence/session-titles/report.md) | 443产品、42声明；rename/CAS/清除/刷新无新反例，store全显示不等于全文机制验证 |
| [Root135静态路径](evidence/root-static-files/report.md) | 条件性handler反例与一次guarded shard；headless/control已有decode，流竞态/HTTPS支持等未建立合同 |
| [137独立静态路径](evidence/mobile-path-review/report.md) | 152产品/14声明/2manifest行；实际public和URL反证，未建立普通产品producer，本人0运行 |

范围/行数与历史、作者和独立复核重叠，不能相加成新增唯一覆盖。只有Root135执行1次测试，其余测试源码是声明。旧计划866明确谈过injected跳过与独立span归档，保留为背景，不称历史从未提过。[Root复核](evidence/review-aggregate.md)。

[共享历史](evidence/root-static-files/history-batch.json)纳冻56排57+，5676 MD/JSON、4212456递归JSON value scalars、0parse错误。topic43/jobs29/storage27/static31/mobile34均在100cap内，titles423只前100。机器访问不是全史语义阅读；作者只认自己的有限窗口。原失败动态方向继续跳过。

六包{c['verbatimCopies']}原件逐字节复制，{c['receiptChecks']}receipt/copy核验，18个report/manifest/receipt锚点；{c['uniqueSourcePins']}唯一pins混合源、测试、指令、配置与hash/nav，不是新增产品全文。[源清单](source-manifest.json)、[复制回执](evidence/prep-copy-receipt.json)、[索引](evidence-index.json)。133三次截断只认完整可见范围下限；137首次错误路径与metadata括号SyntaxError原件保留；136初报结束后必要窄assistant补读时序保留，不倒写成132已读。Root文档生成器首次嵌套引号SyntaxError发生在执行语句前，[诊断转录](evidence/root-document-first-diagnostic.json)明确原stdin脚本未归档，不伪造raw；改成独立文件生成文档，没有重跑产品。

所有源读者冻结后fetch/refresh。读取基线{plan['baseline']}，集成前main {plan['refreshedMain']}。[并发路径](evidence/incoming-main-paths.json)、[历史差异](evidence/incoming-history-drift.json)记录实际变化。只提交owned审查文档和证据fixture，不改产品、不push，原主目录改动按字节保留。

[原4643覆盖快照](evidence/coverage-snapshot-current-binding.json)同SHA；当前多1证据TS，未合并语义增量。304full/168selected/4171unknown受旧目的与机制边界限制；46–53适配未完、54–57未回填，4339不是精确剩余数量。全仓目标active，尚未完成。
''')
(E/'review-aggregate.md').write_text('''# Root复核与正式化

Root实际读六包报告、候选链与清单。132/136同一PET-R132-C1晋升PET-R57-01 P3，计一次，冻结作者包仍0formal/1candidate。Root对实际dispatch/controller/default reader/locator/transcript五源所列选段作前置pin后核对，见pet-root-before-pins.json；与作者/reviewer重叠，不算第三份新增唯一覆盖。

合法未来注册无小于12h上限，idle普通wake实际到dispatch；H同ID/injected写入message.data。S0有至少3普通meaningful消息且autoExtract开启，跨idle成功wake后endH立即缺失；S1下次关闭缺startH；健康真实U新段可恢复，不夸大所有记忆永久失效。136追真实Engine→accounting→Facade→TurnLoop→assistant writer，未补H。旧计划866明确涉及closure skip与独立span机制，不是journal fallback。PET0运行，不借静态资源测试。只有限旧因核查，不保证穷尽全史。

STATIC-R135-C1有一次真实handler单测，但137当前public4和实际URL均ASCII；208路径库存非依赖/bundle闭包。普通默认产品producer未建立，留1candidate，135/137不双计。headless/control已有decode，旧symlink不重报。Root1attempt3test8expect0fail，首输出/exit先保存后读，fixture/import/runner/preload预检hash仍同；无server/socket/proxy/真实模型/worker/Core Engine/native/account/business-network。其他读者0运行。

133追实际executor/process退出和cancel等待，旧R30 final persistence failure排除；134普通title值/CAS/clear/刷新无新反例。完整权限/锁/OS/FS custody不认证。原截断、late metadata pin、导航/metadata首错误及136补读时序保留；Root文档生成首次stdin parse错误只保留实际转录，不伪造原raw脚本。未重跑产品或恢复旧失败方向。

共享5676历史只作bounded导航，archives/JSON递归value参加，cap明确；目录117原116对象保留，非当前未修数。旧4643快照绑定与当前新增1证据fixture分开，后续轮次未回填，不给精确剩余量。只owned docs/证据集成，dirty primary保留，no push，目标active。
''')
groups=['pet-topic','tool-jobs','session-titles','root-static-files','pet-closure-review','mobile-path-review']; checks=[]
for stem in groups:
 d=E/stem; rr=[x for x in ['author-receipt.json','artifact-receipt.json','reviewer-receipt.json'] if (d/x).is_file()]; assert len(rr)==1
 for name in ['report.md','source-manifest.json',rr[0]]:
  p=d/name; b=p.read_bytes(); checks.append(dict(path=str(p.relative_to(O)),bytes=len(b),sha256=sha(b)))
wr(E/'freeze-checks.json',dict(expectedCount=18,checks=checks))
ex=json.loads((E/'frozen-artifact-whitespace.json').read_text())['exactArtifacts']
wr(E/'root-whitespace-review.json',dict(exactTrailingWhitespaceLines={x['path']:x['trailingLineNumbers'] for x in ex},frozenArtifacts=len(ex),scope='Only frozen provenance exceptions; Root files require ordinary whitespace check.'))
rows=[]
for p in sorted(O.rglob('*')):
 if p.is_file() and p.name!='evidence-index.json':
  b=p.read_bytes(); rows.append(dict(path=str(p.relative_to(O)),bytes=len(b),sha256=sha(b)))
wr(O/'evidence-index.json',dict(files=rows,scope='Self excluded; one separately recorded guarded product unit shard, no rerun.'))
print(json.dumps(dict(indexed=len(rows),anchors=len(checks),formal=1,candidates=1,historical=117)))
