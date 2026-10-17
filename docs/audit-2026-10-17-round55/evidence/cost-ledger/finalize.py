from pathlib import Path
import json,hashlib,re,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round124-cost-ledger');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat();sha=lambda b:hashlib.sha256(b).hexdigest()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def ex(rs):return {i for a,b in rs for i in range(a,b+1)}
def ranges(ns):
 out=[]
 for n in sorted(ns):
  if out and n==out[-1][1]+1:out[-1][1]=n
  else:out.append([n,n])
 return out
pins={}
for name in ['initial-pins.json','contract-before-pins.json','usage-producer-before-pins.json']:
 for x in json.loads((O/name).read_text())['files']:pins[x['path']]=dict(x,initialPinArtifact=name)
for name in ['consumer-before-pin.json','settlement-before-pin.json','base-client-before-pin.json']:
 x=json.loads((O/name).read_text());pins[x['path']]=dict(x,initialPinArtifact=name)
config=[
 ('packages/core/src/cost-ledger/pricing.ts','product',[[1,48]],[],[[1,48]],'full','Bundled internal estimate calculation/provider-model lookup for ordinary valid TokenUsage; oldR9 selected/excerpt retained, not first-ever reading or external billing validation'),
 ('packages/core/src/types.ts','product',[[488,496]],[290,732,905,915,916],[[488,493]],'selected','TokenUsage DTO declaration only'),
 ('packages/core/src/cost-ledger/types.ts','product',[[1,51]],[91],[[1,1],[14,18],[37,46]],'selected','Identity and receipt pricing nullable fields/units only; owner/namespace/custody fields boundary'),
 ('packages/core/src/cost-ledger/context.ts','product',[[101,126]],[130],[[101,101],[115,124]],'selected','Ordinary usage forwarding to settle only; AsyncLocal/owner/runtime or fetch lifecycle not certified'),
 ('packages/core/src/data/model-metadata.ts','product',[[26,31],[73,80],[100,110]],[111],[[26,31],[78,80],[102,109]],'selected','Internal bundled price shape/cache heuristic and lookup table projection; no current external rates claim'),
 ('packages/core/src/data/openrouter-models.ts','product',[[24,32],[80,92]],[],[[24,25],[30,31],[84,86]],'selected','Bundled lookup exact model ID and rate fields; no snapshot IO or model/provider execution'),
 ('packages/core/src/cost-ledger/store.ts','product',[[52,76],[248,258]],[15,77,104,225,226,227,236,237,287,301,326,352],[[15,15],[52,76],[225,227],[248,254]],'selected','Ordinary normalized usage and estimate assignment preserving model identity; persist/clock/locks/receipt authority only displayed to boundary'),
 ('packages/core/src/llm/providers/anthropic.ts','product',[[53,72],[257,267],[366,375]],[117,118,119,203,204,218,220,221,247,285,339,340],[[56,72],[264,267],[373,374]],'selected','Ordinary native usage-to-unified TokenUsage cache/input counters; SDK/request/stream/account auth mechanisms not audited or executed'),
 ('packages/core/src/llm/providers/openai.ts','product',[[45,76],[710,725],[921,933]],[490,492,493,783],[[61,75],[717,725],[926,932]],'selected','Reported cache details and ordinary TokenUsage fields/recordUsage calls; dated comments are not external verification'),
 ('packages/core/src/llm/client-base.ts','product',[[115,129]],[13,142],[[13,13],[115,126]],'selected','Ordinary reported/null usage forwarded to recordOwnedUsage; no callback/error/client/network lifecycle certification'),
 ('packages/core/src/cost-ledger/ledger.test.ts','test-declaration',[[94,113]],[32,40,52,114,117,119,120,124,126,128,130,136,169,183,193,231,258,260,264,276,285,301,342,369,391,431],[[94,105]],'selected','Existing unknown-price/missing-usage declarations only; storage corrupt fixture and all tests never executed'),
 ('packages/core/src/llm/providers/anthropic-usage.test.ts','test-declaration',[[33,41],[66,73]],[4,5,18,19,20,43,55],[[34,40],[67,71]],'selected','Existing ordinary unified cache-token assertions only, no imports/network/SDK/tests run'),
]
rows=[]
for p,kind,body,nav,sel,cov,purpose in config:
 q=pins[p];shown=ex(body)|set(nav);selected=ex(sel);assert selected<=shown and max(shown)<=q['lines']
 rows.append(dict(path=p,bytes=q['bytes'],sha256=q['sha256'],lineCount=q['lines'],coverage=cov,kind=kind,selectedLineRanges=sel,semanticLineCount=len(selected),displayedBodyLineRanges=body,additionalNavigationSnippetLines=sorted(set(nav)-ex(body)),displayedLineRanges=ranges(shown),displayedLineCount=len(shown),purpose=purpose,initialPinArtifact=q['initialPinArtifact'],firstReadSha256=q['sha256'],firstPinUTC=q['pinnedBeforeBodyUTC'],firstEverSemanticReadPin=None,priorReadingOverlap='Not an unread/first-ever source claim; original canonical scopes retained separately'))
prod=sum(x['semanticLineCount']for x in rows if x['kind']=='product');tests=sum(x['semanticLineCount']for x in rows if x['kind']=='test-declaration');disp=sum(x['displayedLineCount']for x in rows)
hashrows=[]
for p in ['packages/core/src/cost-ledger/summary.ts','packages/core/src/cost-ledger/index.ts']:
 q=pins[p];hashrows.append(dict(**q,coverage='hash-only; zero current product body',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0,purpose='summary same-SHA old49 full81 pre-body excluded'if p.endswith('summary.ts')else'Unused barrel pin; symbol search had no matching consumer body, no source content opened'))
save('source-manifest.json',dict(createdAt=now(),rootReportedBaseline='00c046367769349c1f5413e74c993b2c19ce8337',gitCertified=False,files=rows,hashOnlyFiles=hashrows,instructionPins=[dict(**pins[p],coverage='hash-only this packet, previous same-SHA instruction reading reused')for p in ['CODESHELL.md','AGENTS.md']],productSemanticLineCount=prod,testDeclarationLineCount=tests,semanticLineCount=prod+tests,displayedLineCount=disp,fullProductFiles=1,selectedProductFiles=9,selectedTestDeclarationFiles=2,rangeConvention='Per-file unique body+navigation union; semantic ranges purpose-bounded subset; tests are declaration-only; repeated output never sums unique lines.',sourceReadingEndedBeforeFinalization=True,globalCoverageUpdated=False,limits=['No new full/selected source reading of summary; original49 full81 does not prove no aggregation bugs.','Pricing48 is a current full static ordinary-estimate read, not a first-ever/unique coverage claim; oldR9 selected/excerpt source labels retained.','Provider, credential, runtime/context, IO/lock, actual account/bill/model/client/network mechanisms only displayed to specified boundary and never executed.']))
ref=json.loads((O/'shared-history-reference.json').read_text());b=Path(ref['source']).read_bytes();sharedok=len(b)==ref['bytes']and sha(b)==ref['sha256'];checks=[]
for p,q in pins.items():
 raw=(R/p).read_bytes();checks.append(dict(path=p,bytes=len(raw),sha256=sha(raw),matchesInitial=len(raw)==q['bytes']and sha(raw)==q['sha256']))
meta=[]
loc=json.loads((O/'canonical-locator-metadata.json').read_text())
for x in loc['documents']:meta.append(dict(path=x['document'],bytes=x['bytes'],sha256=x['sha256']))
r9=json.loads((O/'r9-canonical-metadata.json').read_text());meta.append(dict(path=r9['document'],bytes=r9['bytes'],sha256=r9['sha256']))
meta+=json.loads((O/'selected-prior-reports.json').read_text())['files'];metachecks=[]
for x in meta:
 raw=(R/x['path']).read_bytes();metachecks.append(dict(path=x['path'],bytes=len(raw),sha256=sha(raw),matchesInitial=len(raw)==x['bytes']and sha(raw)==x['sha256']))
assert all(x['matchesInitial']for x in checks+metachecks)and sharedok
save('ending-checks.json',dict(createdAt=now(),sourceAndInstructionChecks=checks,selectedCanonicalMetadataChecks=metachecks,sharedBatch=dict(path=ref['source'],bytes=len(b),sha256=sha(b),matchesInitial=sharedok),allPinnedBytesUnchanged=True,wholeSharedHistoryInventoryIndependentlyRehashed=False,limitation='Root owns shared5433 history batch/ending; this reviewer checks immutable batch bytes and actually selected canonical docs only, not falsely claiming an independent full5433 ending audit.',sourceBodyReadForEnding=False,gitExecuted=False))
save('classification.json',dict(createdAt=now(),formal=[],candidates=[],newRelated=[],counts=dict(formal=0,candidates=0,newRelated=0),oldSameShaFullPreBodyExclusions=1,oldCauseDecisions=[dict(id='COST-R9-01',decision='Existing independent/unbound CostTracker loses full model ID; no new finding or repeated count. Current ledger estimate consumes identity separately; no standalone tracker tests run.'),dict(id='R49-/cost-empty-singleton-hypothesis',decision='Existing actual in-process local binding refutes former remote empty tracker trigger; not reopened.')],assessment='Finite negative for ordinary bundled estimate math/nullable pricing/unified usage handoff; not all ledger summary/persistence/provider/billing contracts'))
save('diagnostics.json',dict(createdAt=now(),metadataCommandFailures=2,firstSyntaxError='metadata-first-diagnostic.json',staticLocatorError=dict(toolChunk='9cff6c',exitCode=2,command='rg -l cacheCreationTokens packages/core/src/providers',error='Source directory does not exist; corrected by later rg --files canonical inventory to llm/providers, no product/provider execution',originalByteRawCaptured=False,originalToolVisibleOutput='rg: packages/core/src/providers: IO error for operation on packages/core/src/providers: No such file or directory (os error 2)'),normalNoMatchQueries=[dict(toolChunk='2c0700',exitCode=1,scope='OldR9 filename-only *cost*/*ledger* search no hits'),dict(toolChunk='1709f1',exitCode=1,scope='Pinned cost-ledger/index.ts symbol search no matches; no body read')],metadataOutputTruncations=0,productFailures=0,productRetries=0,oldFailedDynamicDirectionsRestored=False))
save('validation.json',dict(createdAt=now(),productExecutions=0,helperExecutions=0,importExecutions=0,testExecutions=0,fixtureExecutions=0,timerNetworkNativeModelAccountBillingGitExecutions=0,authorSharedBatchMethodExecuted=False,historyMethod='Root-provided frozen shared batch projected; no duplicate global scalar scan by reviewer',guardedTestPlan='No new normal-input defect supported, so no new runtime/guarded plan proposed.',productSemanticLineCount=prod,testDeclarationLineCount=tests,displayedLineCount=disp))
report=f'''# Cost-ledger普通估价：有限静态审查

**0正式 / 0候选 / 0新增关联。** 完整读取当前 pricing.ts48行，并核其普通 usage producer→ledger settlement消费分支，未建立正常输入的新反例。外部最新价格、实际账单、账户、provider请求或持久化机制均未验证；所有产品/helper/import/test/fixture/timer/network/native/model/Git执行0。

内部合同与反证：pricing.ts6明确bundled estimate，未找到price时返回pricing/cost为null而不是默认价。direct provider只查bundled MODEL_PRICING，OpenRouter用完整vendor/model ID查snapshot；cache价明确标estimated。模型表的cacheRead/cacheWrite由内部统一pair推导，不能把它当作实时价格或发票承诺。Anthropic普通usage将read/write cache计入prompt总数，OpenAI-compatible计数从details映射；pricing再从prompt剔出已缓存部分、分别乘对应估价，未发现这条正常合同的二次计入。client-base115–126→context101/115–124→store.normalizeUsage52–76/settle248–254把报告usage保留并调用estimateReceipt；store225–227保留model字段。没有用任意坏DTO或假设实际provider价格制造问题。

[旧canonical范围](canonical-locator-metadata.json)与[R9原对象](r9-canonical-metadata.json)表明pricing原R9仅selected/excerpt，不能叫历史未读/首次。本次pricing full48亦不增加“独有首次覆盖”声明。summary.ts81行同SHA `4ef61d2b…` 在原49 root-summary-review `/files/0` 已明确full1–81；本包在正文前排除，当前body0，不声称重新验证其汇总合同。旧COST-R9-01是未绑定standalone CostTracker丢完整model ID；原R49远程空singleton假设被实际in-process绑定反证，已读两份原MD共49行，均不重报或恢复旧运行。

[共享历史投影](history-projection.json)引用Root冻结batch（5433份MD/JSON，纳54排55+，3997418 recursiveJSONvalue scalars、archives包含、0parse错）；pricing合并path/SHA命中79全存，summary145仅前100。该batch是path/SHA导航，不冒充旧因语义穷尽；本review定向亲读原canonical对象/上述旧报告，未再扫全史百万scalar。原batchSHA/时间见[引用](shared-history-reference.json)，Root另行归档原件一次。

[准确范围](source-manifest.json)：1full+9selected产品，共{prod}产品语义行；2既有测试文件选读{tests}行声明；合计{prod+tests}语义、{disp}唯一display行。导航、IO/clock/auth/client边界、重复显示和旧作者阅读不加成语义覆盖。既有unknown-price/Anthropic cache断言仅作声明反证，未执行任何测试。summary与未启用index barrel为hash-only，指令文件本次仅核同SHA并复用先前阅读。

[首诊断](diagnostics.json)保留自有metadata presenter语法首错、错误source目录定位和正常no-match；修正仅用于metadata展示/文件名导航，不是产品重试，截断0。[ending](ending-checks.json)核16个源/指令pin、6份选读原metadata及共享batch全同；不声称独立重验共享5433份history全部字节。分类见[classification](classification.json)，运行边界见[validation](validation.json)。源阅读已结束，仅写exact tmp，未改产品或121冻件。
'''
(O/'report.md').write_text(report)
links=[]
for m in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',report):
 q=(O/m.group(1)).resolve();links.append(dict(target=m.group(1),exists=q.is_file(),insidePacket=q.is_relative_to(O.resolve())))
assert all(x['exists']and x['insidePacket']for x in links)
save('checks.json',dict(createdAt=now(),files=[],sourceAndInstructionPins=len(checks),selectedCanonicalMetadataPins=len(metachecks),sharedBatchUnchanged=sharedok,allPinnedBytesUnchanged=True,localLinks=links,allValid=True,fullProductFiles=1,selectedProductFiles=9,testDeclarationFiles=2,productSemanticLineCount=prod,testDeclarationLineCount=tests,displayedLineCount=disp,classification='0/0/0',productExecutions=0,Git=0))
receipts=[]
for p in sorted(O.iterdir()):
 if p.is_file()and p.name!='artifact-receipt.json':
  raw=p.read_bytes();receipts.append(dict(path=p.name,bytes=len(raw),sha256=sha(raw)))
save('artifact-receipt.json',dict(createdAt=now(),frozen=True,scope='Exact packet files excluding this self-receipt; shared root batch referenced/projected only, no author method or product execution',files=receipts))
for n in ['report.md','source-manifest.json','artifact-receipt.json']:
 raw=(O/n).read_bytes();print(n,len(raw),sha(raw))
print(json.dumps(dict(files=len(receipts)+1,receipt=len(receipts),links=len(links),sourcePins=len(checks),metadataPins=len(metachecks),productSemantic=prod,testDeclaration=tests,totalSemantic=prod+tests,display=disp,classification='0/0/0',sourceEndingChanges=0),ensure_ascii=False))
