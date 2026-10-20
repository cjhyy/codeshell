from pathlib import Path
import json,hashlib,datetime,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
def sha(b):return hashlib.sha256(b).hexdigest()
def load(n):return json.loads((out/n).read_text())
def write(n,v):(out/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def merged(rs):
 vals=sorted({i for a,z in rs for i in range(a,z+1)}); result=[]
 for i in vals:
  if result and i==result[-1][1]+1:result[-1][1]=i
  else:result.append([i,i])
 return result
initial=load('initial-pins.json');init={r['path']:r for r in initial['files']}
for r in load('chain-before-navigation-pins.json'):init.setdefault(r['path'],r)
readrows=load('leaf-before-read-pins.json')+load('chain-before-read-pins.json')+load('supplement-before-read-pins.json')
by={}
for r in readrows:
 p=r['path']
 if p not in by:by[p]={**r,'selectedLineRanges':[]}
 by[p]['selectedLineRanges']+=r['selectedLineRanges']
nav={}
for group in load('chain-navigation.json'):
 for line in group['output'].splitlines():
  m=re.match(r'([^:]+):(\d+):',line)
  if m:nav.setdefault(m[1],set()).add(int(m[2]))
scopes={
 'resolve.ts':'Full physical body read; ordinary exact catalog/preset lookup and returned model/paramValues fields. Credential compatibility, secret use and runtime behavior are not certified.',
 'gen-connections.ts':'Full physical body read; normal tag filtering and id/kind/baseUrl/defaultModel projection; no real provider or credential operation.',
 'upsert.ts':'Full physical body read; exact id/value append/replace and copied input array; no storage durability certification.',
 'types.ts':'Selected catalog/preset field shape and ordinary merge-mode declarations only; schema not executed.',
 'index.ts':'Selected getMergedCatalog and findCatalogEntry value/order contracts only; user-catalog filesystem loader not read or run in this packet.',
 'save-entry.ts':'Selected validation/result and actual upsert call site. Lock/backup/atomic-write names appear, but their implementations and durability are not audited or run.',
 'generate-image.ts':'Selected unified connection list, model default selection and downstream call model precedence. Adjacent legacy/key and trace setup are shown, without authentication, transport or model execution certification.',
 'generate-video.ts':'Selected unified connection list, default model forwarding and call override precedence. No upload, transport, authentication or generation is run or certified.'}
files=[]
for p,row in by.items():
 rs=merged(row['selectedLineRanges']);lines={i for a,z in rs for i in range(a,z+1)};first=init[p];is_test='.test.' in p
 files.append({'path':p,'bytes':row['bytes'],'lines':row['lines'],'sha256':row['sha256'],'initialPinAtUTC':first.get('pinAtUTC',first.get('pinAt')),'initialSemanticReadSha256':first['sha256'],'coverage':'full' if rs==[[1,row['lines']]] else 'selected','selectedLineRanges':rs,'displayedLineRanges':rs,'semanticReadLineRanges':rs,'semanticReadLines':len(lines),'sourceKind':'test-declaration' if is_test else 'product','scope':('Selected existing test declarations; tests/imports/assertions were not executed and no current pass is claimed.' if is_test else scopes[Path(p).name]),'navigationLineRanges':merged([[n,n] for n in nav.get(p,set())]),'navigationOnlyLineRanges':merged([[n,n] for n in nav.get(p,set())-lines]),'oldOverlap':'R10 catalog report/source pins document prior static reading; exact full-file extent was not explicit in that source manifest. resolve additionally has explicit R17 80–113 same-SHA selected overlap.' if Path(p).name in ['resolve.ts','gen-connections.ts','upsert.ts'] else 'Necessary chain/test selected reading; no claim of first or unique new coverage.'})
for p in ['CODESHELL.md','AGENTS.md']:
 r=init[p];files.append({'path':p,'bytes':r['bytes'],'lines':r['lines'],'sha256':r['sha256'],'initialPinAtUTC':r.get('pinAtUTC',r.get('pinAt')),'coverage':'hash-only','selectedLineRanges':[],'displayedLineRanges':[],'semanticReadLineRanges':[],'semanticReadLines':0,'sourceKind':'instruction','scope':'Previously read unchanged instructions, hash-only reuse; no new instruction semantic lines.'})
prod=sum(r['semanticReadLines'] for r in files if r['sourceKind']=='product');tests=sum(r['semanticReadLines'] for r in files if r['sourceKind']=='test-declaration')
meta=load('canonical-initial-pins.json')+load('prior-report-initial-pins.json');shared=load('history-projection.json')['sharedBatch']
end=[]
for r in files:
 b=(root/r['path']).read_bytes();end.append({'path':r['path'],'initialSha256':r['sha256'],'endingSha256':sha(b),'initialBytes':r['bytes'],'endingBytes':len(b),'same':sha(b)==r['sha256'] and len(b)==r['bytes']})
metaend=[]
for r in meta:
 b=(root/r['path']).read_bytes();metaend.append({'path':r['path'],'initialSha256':r['sha256'],'endingSha256':sha(b),'same':sha(b)==r['sha256']})
b=Path(shared['path']).read_bytes();metaend.append({'path':shared['path'],'initialSha256':shared['sha256'],'endingSha256':sha(b),'same':sha(b)==shared['sha256']})
write('ending-checks.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':end,'metadataFiles':metaend,'allSourceSame':all(r['same'] for r in end),'allSelectedMetadataSame':all(r['same'] for r in metaend),'wholeHistoryEndingRehashed':False,'scope':'Only source pins, six directly selected canonical metadata files and shared batch bytes rehashed; no new whole-history scan or product semantic read.'})
counts={'files':len(files),'productFiles':sum(r['sourceKind']=='product' for r in files),'testDeclarationFiles':sum(r['sourceKind']=='test-declaration' for r in files),'instructionHashOnlyFiles':2,'productSemanticLines':prod,'testDeclarationLines':tests,'productAndTestDisplayedLines':prod+tests,'fullProductFiles':sum(r['sourceKind']=='product' and r['coverage']=='full' for r in files),'selectedProductFiles':sum(r['sourceKind']=='product' and r['coverage']=='selected' for r in files)}
manifest={'root':str(root),'rootReportedHead':'d195788bc2c18cd85c81aea4a431ab29074df5cf','rootReportedBranch':'codex/audit/catalog-source-theme-round62-20261018','GitVerified':False,'files':files,'metadataFiles':meta,'sharedHistory':shared,'counts':counts,'coverageMeaning':'Physical full/selected source reading for the stated ordinary contract only, not all-behavior validation, first reading, unique new coverage or runtime certification. Navigation outside selected ranges is separate and not semantic-body coverage.','priorMetadataRead':{'canonicalObjects':4,'canonicalObjectEvidence':'canonical-selected-objects.json','reports':load('prior-report-read-ranges.json'),'totalSelectedMarkdownLines':sum(x['displayLines'] for x in load('prior-report-read-ranges.json'))},'productExecutions':0,'testsExecuted':0,'gitCalls':0,'networkCalls':0}
write('source-manifest.json',manifest)
write('classification.json',{'formalFindings':[],'candidates':[],'newRelatedFindings':[],'counts':{'formal':0,'candidate':0,'newRelated':0},'result':'Finite static negative for selected ordinary model/connection field contracts.','existingObservationsRetained':[{'id':'CATALOG-R17-C1','status':'old candidate; Panel default-vs-core fallback contract remains as recorded, no recount/promotion'},{'id':'CATALOG-R17-C2','status':'old candidate; Panel trim identity contract remains as recorded, no recount/promotion'}],'oldFailureSkip':'R10 guessed packages/core/src/engine.ts static cache-refresh call-chain failure remains skipped; no corrected-path retry or replacement product validation.','counterevidence':[{'source':'packages/core/src/model-catalog/resolve.ts:91-111','conclusion':'Exact catalog id/preset value resolution preserves inst.model/paramValues; absent catalog returns null. This ordinary check does not certify credential policy.'},{'source':'packages/core/src/model-catalog/gen-connections.ts:29-40','conclusion':'Tag filtering retains connection id, resolved adapter kind/base URL, and model or catalog default.'},{'source':'packages/core/src/tool-system/builtin/generate-image.ts:193-204,424-439; generate-video.ts:239-263,350-370','conclusion':'Actual unified settings consumers carry bridge defaultModel through normal provider selection to call-arg > instance-default > kind-default model choice.'},{'source':'packages/core/src/model-catalog/upsert.ts:10-24; save-entry.ts:123-138; index.ts:68-86','conclusion':'Exact id/value replacement preserves order via a copied array; actual validated save call uses this helper and selected catalog merge preserves per-value keyed preset replacement.'}],'notEstablished':'No declared normal producer requiring a contrary mapping/priority/duplicate-entry behavior was established. This does not prove all accepted configurations or lifecycle behavior correct.','runtimeValidation':'none; no tests/import/helper/provider/fs mutation/network/model execution'})
write('diagnostics.json',{'firstMetadataSchemaPeek':{'toolChunkId':'5bb239','exitCodeObserved':0,'scope':'Shared history-batch top-level keys/counts only, no source body.','rawSeparatelyCaptured':False,'limitation':'Displayed from the tool response before separate stdout/stderr/exit artifact saved; capture-process deviation, no raw stream fabricated.'},'projectionDisplayCap':{'toolChunkId':'309729','childExitCode':0,'rawStdoutArtifact':'project-history.first.stdout.txt','rawStdoutBytes':len((out/'project-history.first.stdout.txt').read_bytes()),'wrapperDisplayedFirstChars':24000,'meaning':'Deliberate display cap cut inside early gen-connections compact navigation metadata. All 300 saved shared hits are in history-projection.json; they are not all semantic reads.'},'firstFinalizerOuterError':load('finalizer.first.outer-observed.json'),'firstFinalizerChildError':{'exitArtifact':'finalize-packet.corrected.exit.json','stderrArtifact':'finalize-packet.corrected.stderr.txt','scriptArtifact':'finalize-packet.pinfield.first.py','error':'KeyError pinAtUTC; original initial-pins rows use pinAt','correction':'Map original pinAt value, do not backfill or repeat source reads'},'currentSourceDisplayTruncations':[],'oldFailuresPreserved':['R10 catalog-static-read-failure.md: guessed engine.ts cache-refresh direction skipped','R17 catalog-navigation-skip.md: historical glob/receipt-order diagnostics are not new executions'],'productFailuresOrTestRuns':0})
report=f'''# 模型目录普通字段静态复核（预备164）

本包 **0 正式、0 候选、0 新 related**。有限复核未建立普通模型/连接字段的新反例；不是整个模型接入、凭证或持久化行为正确性结论。

Root 报告 owned HEAD `d195788bc2c18cd85c81aea4a431ab29074df5cf`，分支 `codex/audit/catalog-source-theme-round62-20261018`；本作者 Git 0，未独立认证提交绑定。仅写本 exact tmp，产品源码无写入。

1. `resolve.ts` 1–113、`gen-connections.ts` 1–43、`upsert.ts` 1–25 全文物理阅读；普通字段目的是精确 catalog/preset lookup、tag/id/model 投影与有序替换。实际 image/video 的 unified modelConnections 消费和模型覆盖顺序，以及 schema→save→upsert→catalog merge 为选段阅读，见 [精确范围与预读 pin](source-manifest.json)。共 {prod} 产品语义行、{tests} 既有测试声明行，显示 {prod+tests} 行；声明未执行。3 product full、5 product selected、2 test selected、2 instruction hash-only。导航命中行另列，不加作正文覆盖。
2. 普通字段反证：桥接保留连接 id/adapter/baseUrl，连接 model 优先于 catalog default；真实图像/视频入口继续使用 call model → instance default → kind default。upsert 精确 id/value 替换并复制数组，保存入口实际调用它，merge-mode 以 preset.value 更新。未建立正常 producer 要求相反优先级或丢字段的合同，不以任意重复/坏配置制造问题。详见 [分类与逐链依据](classification.json)。
3. 已亲读 R10 catalog.md 全35行和原清单 /files/3、/4、/7，三源同 SHA；原清单没有明确全文范围，不能仅以 pin 升格旧 full。R17 /sources/14 明确 resolve 80–113 selected 同 SHA；其 catalog.md 全43行与旧导航诊断31行已读。故保留旧静态重叠，不称首读/唯一新增覆盖。两旧 Panel default/trim 候选保持原分类，不重报、不计 related。R10 cache-refresh 猜 engine.ts 失败方向仍 SKIP，不恢复。
4. Root166 共享历史机器导航纳冻61、排62+，6484 MD/JSON、4,639,853 JSON value scalars、errors=[]，含 archive；resolve/gen/upsert 总命中157/130/125，各仅保存前100。这里保存 [目标投影](history-projection.json)，不复制整库存。机器命中、派生 coverage 和保存窗口不等于历史全读或根因查重穷尽。本作者实际原件阅读为4个 canonical JSON objects +119行旧 MD；见 [原对象](canonical-selected-objects.json) 与 [旧报告范围](prior-report-read-ranges.json)。
5. 未验证：真实 Settings/用户目录、锁/备份/atomic write 机制、凭证授权、provider 可用性、网络生成、GUI、跨进程生命周期和所有 accepted config。产品/helper/import/fixture/test/native/model/network 执行均0，无修复、无动态替代验证。

初始 pins 均在产品正文/行导航前持久化；ending 的12个源/指令 pins 与6份直接旧材料及共享batch均未变，见 [结束检查](ending-checks.json)。未重 hash 全6484历史文件。首次共享 schema 的 keys/counts peek 未先单独保存 raw stream，及封包外层引号错误 exit1 已如实记 [诊断](diagnostics.json)，后者在写入 finalizer/启动 child 前发生。随后 child 另有 pinAtUTC 字段名 KeyError，首脚本和 stdout/stderr/exit 保留；只适配原 pinAt 值，不倒填时间、不重复源阅读。各实际执行 audit child 的 stdout/stderr/exit 均先落盘后展示。导航投影首输出有主动24,000字符显示上限，完整 raw 已保存，不冒称300命中均已人工读完。当前源正文输出未截断，无产品执行失败。
'''
(out/'report.md').write_text(report)
links=[]
for label,target in re.findall(r'\[([^\]]+)\]\(([^)]+)\)',report):links.append({'label':label,'target':target,'exists':(out/target).is_file()})
assert all(x['exists'] for x in links);assert all(x['same'] for x in end+metaend)
write('checks.json',{'reportLinks':links,'allReportLinksExist':True,'classification':{'formal':0,'candidate':0,'newRelated':0},'sourceCounts':counts,'selectedCanonicalObjects':4,'selectedPriorMarkdownLines':119,'sourceEndingSame':True,'selectedMetadataEndingSame':True,'filesAreSourcesNotCurrentArtifacts':True,'gitCalls':0,'productExecutions':0})
print(json.dumps({'classification':'0/0/0','sourceRows':len(files),'productLines':prod,'testDeclarationLines':tests,'displayLines':prod+tests,'sourceEndingAllSame':True,'reportLinks':len(links)},ensure_ascii=False))
