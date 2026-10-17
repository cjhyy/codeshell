from pathlib import Path
import json,hashlib,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round126-model-pool')
def sha(b):return hashlib.sha256(b).hexdigest()
def w(n,j):(D/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
pins=[]
for name in ['initial-pins.json','consumer-initial-pins.json','test-initial-pins.json']:pins.extend(json.loads((D/name).read_text())['files'])
by={r['path']:r for r in pins}
specs=[('packages/core/src/llm/model-pool.ts','full',[[1,325]],[[1,325]]),('packages/core/src/engine/model-connections-pool.ts','full',[[1,80]],[[1,80]]),('packages/core/src/llm/provider-catalog.ts','full',[[1,75]],[[1,75]]),('packages/core/src/engine/resolve-llm-config.ts','full',[[1,74]],[[1,74]]),('packages/core/src/llm/reasoning-setting.ts','full',[[1,46]],[[1,46]]),('packages/core/src/engine/runtime.ts','selected',[[80,101]],[[72,108]]),('packages/core/src/engine/engine.ts','selected',[[904,952],[1028,1031],[1040,1056],[3642,3668]],[[904,957],[1024,1061],[1426,1447],[3638,3679]]),('packages/core/src/llm/model-pool.test.ts','full',[[1,43]],[[1,43]]),('packages/core/src/engine/model-connections-pool.test.ts','selected',[[160,229],[297,321]],[[160,229],[297,321]]),('packages/core/src/engine/resolve-llm-config.test.ts','selected',[[50,65]],[[50,65]])]
rows=[];excerpts=[]
for p,cov,semantic,shown in specs:
 pin=by[p];b=(R/p).read_bytes();assert sha(b)==pin['sha256'];lines=b.decode().splitlines();count=sum(z-a+1 for a,z in semantic);body=sum(z-a+1 for a,z in shown)
 rows.append(dict(path=p,bytes=len(b),sha256=pin['sha256'],lines=len(lines),coverage=cov,selectedLineRanges=semantic,bodyDisplayedLineRanges=shown,semanticLines=count,bodyDisplayedLines=body,role='existing test declarations only, never executed' if '.test.' in p else 'ordinary source contract static',scope='Whole listed file ordinary in-memory/schema/config mapping only where full. External helper/import/provider/cache/credential/SDK behavior not certified; adjacent Engine session restoration source display not semantic coverage.',beforeBodyOrLineNavigation=True,historicalOverlap='Target has prior same-SHA R4/R10 pins and selected catalog question, not a first/unread claim. Other necessary consumers may overlap older reviews; not unique new whole-repository coverage.'))
 excerpts.append(dict(path=p,sha256=pin['sha256'],captureTiming='After actual source display; initial pin predates display.',blocks=[dict(start=a,end=z,lines=[dict(line=n,text=lines[n-1]) for n in range(a,z+1)]) for a,z in shown]))
w('source-excerpts.json',dict(files=excerpts,productExecution=0))
hist=[]
for name,i in [('docs/audit-2026-10-17-round4/evidence/settings-source-manifest.json',14),('docs/audit-2026-10-17-round10/evidence/catalog-source-manifest.json',17)]:
 j=json.loads((R/name).read_text());hist.append(dict(document=name,jsonPointer='/files/'+str(i),row=j['files'][i],ancestorScope=j.get('scope'),interpretation='Same SHA pin / inspected-read label without unambiguous whole-file range; no guaranteed unread or complete claim.'))
w('canonical-metadata.json',dict(rows=hist,priorCause='R10 reloadCachedContextWindows inferred-values/provenance is excluded/archived, not reopened.'))
batch=json.loads((D/'history-batch.json').read_text());changed=[];missing=[]
for r in batch['inventory']:
 p=R/r['path']
 if not p.is_file():missing.append(r['path'])
 else:
  b=p.read_bytes()
  if len(b)!=r['bytes'] or sha(b)!=r['sha256']:changed.append(r['path'])
assert not changed and not missing
w('ending-checks.json',dict(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),sourcePins=[dict(path=r['path'],sha256=r['sha256'],same=sha((R/r['path']).read_bytes())==r['sha256']) for r in pins],historyFiles=len(batch['inventory']),changed=changed,missing=missing,productRuns=0))
assert all(sha((R/r['path']).read_bytes())==r['sha256'] for r in pins)
w('source-manifest.json',dict(files=rows,totals=dict(fullFiles=6,selectedFiles=4,productSemanticLines=sum(r['semanticLines'] for r in rows if '.test.' not in r['path']),testDeclarationLines=sum(r['semanticLines'] for r in rows if '.test.' in r['path']),bodyDisplayedLines=sum(r['bodyDisplayedLines'] for r in rows)),navigationNote='Filename-only rg found support/test paths. Subsequent rg-n title/import/call locators were navigation, not additional whole-source semantic coverage; adjacent cold restoration and provider-dispatch prose not promoted.',rootReportedBaselineOnly='00c046367769349c1f5413e74c993b2c19ce8337',productExecution=0))
w('classification.json',dict(formal=[],candidates=[],related=[],counterevidence=[dict(question='False/off reasoning lost by ModelPool conditional?',finding='Reasoning is a discriminated object; producer maps false to {mode:off}, object remains truthy and gets carried. Existing declaration covers on/off.'),dict(question='Token caps or extraBody lost at model switch?',finding='Producer copies preset limits and nonreasoning extraBody; toLLMConfig carries maxOutputTokens without inventing limit, entry extraBody and modelKey; Engine replaces model LLMConfig and keeps separate clientDefaults.'),dict(question='No params must inject reasoning default?',finding='Existing declaration explicitly expects no reasoning when no paramValues. No new contract violation established.'),dict(question='First usable fallback with orphaned credentials?',finding='Selected missing-key connection is explicitly rejected by resolver. No new supported normal mixed-state contract/producer counterexample established in this finite pass; no dynamic or SDK resolver test reopened.')],exclusions=['R10 inferred context cache reload/provenance excluded old cause','Arbitrary returned-reference mutation, duplicate keys and unsupported malformed settings not promoted without real caller','Cold session connection identity source displayed adjacent only; not audited here','Actual provider prices/context quotas not asserted from comments']))
w('validation.json',dict(productAttempts=0,passedTests=0,expectations=0,testDeclarationsOnly=True,scope='No product/helper/import/fixture/test/SDK/model/credential/cache-file/clock/native/network execution. Source call boundary does not certify called mechanism. Git integration metadata separately Root-owned.'))
(D/'report.md').write_text('''# Root126：ModelPool与正常连接参数合同

有限结论 **0新增正式问题、0候选、0新增关联**。普通注册/模型参数投影、真实producer与Engine消费链未建立新反例，不认证所有模型能力、SDK、账户、cache权限或实际请求行为。

[初始pin](initial-pins.json)在正文/行导航前，model-pool.ts325行13195B SHAa49da…。[历史batch](history-batch.json)同5433历史范围纳54排55+，path/SHA命中150保存前100、0parse错误；机器命中不等于全语义阅读。实际先读前35个有限命中（过滤大coverage项），核[两个原canonical对象](canonical-metadata.json)：R4只有SHA，R10 inspected/read scope不标完整文件；R10 catalog.md15的缓存推断与来源旧因明确排除。原范围可能重叠，不称首次或从未阅读。

[范围清单](source-manifest.json)列5个完整产品文件（model-pool325、connection bridge80、provider catalog75、resolver74、reasoning schema46）及runtime/Engine必要选段；另1完整现有测试声明43行及2测试选段111行。产品语义719行、测试声明154行，共873；正文实际显示947行，差集只相邻展示。其它rg-n测试标题/import/call locator只导航，不增加语义行；Engine5082行未全文阅读，冷会话restore相邻显示不纳本次语义。所有support/test在行导航前[pin](consumer-initial-pins.json)、[test pin](test-initial-pins.json)，[摘录](source-excerpts.json)在实际显示后保存，不倒填首次pin。

正常合同与反证：ModelPool保留alias/modelKey、显式maxOutputTokens/context和extraBody，未指定maxOutputTokens不捏造8192。真实modelEntriesFromConnections按catalog protocol映射client family，复制preset限制，reasoning另走discriminated object而不在extraBody重复发；false转{mode:off}仍truthy，toLLMConfig条件不丢off。provider catalog没有extraBody字段，不能凭不存在的字段声称丢失；普通headers合并顺序在源内明确，外部authCommand未执行。

Engine启动/热切换以toLLMConfig替换模型身份而保留独立clientDefaults；runtime重建池先clear再登记并选defaults/first，未知binding消费处明确报错。具体consumer范围与边界保留，不把return reference/任意重复alias等无真实producer猜想报bug。现有声明支持缺params没有reasoning、on/off对象、cap及extraBody传递；没有借声明推定通过。缺key的所选连接明确被resolver拒绝；本轮未建立正常mixed-state fallback新反例，不恢复已失败SDK方向。[分类](classification.json)逐条保留。

[验证](validation.json)产品/helper/import/fixture/test/模型/凭证/网络/native运行均0，无产品失败重试。[结束检查](ending-checks.json)10个源/测试pins及原5433历史成员字节全同。首扫描stdout/stderr/exit保留，exit0。Root125/126是同一作者两个有限任务，不说成独立双人复核。旧统一覆盖未重算，6full标签包含测试声明，不能加到304作为新全仓完整数。
''')
art=[]
for p in sorted(D.iterdir()):
 if p.is_file() and p.name!='author-receipt.json':
  b=p.read_bytes();art.append(dict(path=p.name,bytes=len(b),sha256=sha(b)))
w('author-receipt.json',dict(frozen=True,files=art,scope='Exact finite Root126 source static and metadata package, self excluded. Product execution0.'))
print(json.dumps(dict(files=len(art)+1,receipt=len(art),totals=json.loads((D/'source-manifest.json').read_text())['totals'])))
