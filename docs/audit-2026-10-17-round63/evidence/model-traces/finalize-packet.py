from pathlib import Path
import json,hashlib,datetime,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round168-model-traces')
def load(n):return json.loads((out/n).read_text())
def put(n,v):(out/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def digest(b):return hashlib.sha256(b).hexdigest()
def union(rs):
 result=[]
 for i in sorted({i for a,z in rs for i in range(a,z+1)}):
  if result and i==result[-1][1]+1:result[-1][1]=i
  else:result.append([i,i])
 return result
initial=load('initial-pins.json');first={r['path']:r for r in initial['files']}
for r in load('chain-before-navigation-pins.json'):first.setdefault(r['path'],r)
read={}
for r in load('leaf-before-read-pins.json')+load('chain-before-read-pins.json')+load('supplement-before-read-pins.json'):
 if r['path'] not in read:read[r['path']]={**r,'selectedLineRanges':[]}
 read[r['path']]['selectedLineRanges']+=r['selectedLineRanges']
nav={}
for group in load('chain-navigation.json'):
 for line in group['stdout'].splitlines():
  m=re.match(r'([^:]+):(\d+):',line)
  if m:nav.setdefault(m[1],set()).add(int(m[2]))
scopes={
 'native-frames.ts':'Full physical body reading for ordinary frame identity/part accumulation and final UTF8/JSON projection. No native producer, FD, clock, Buffer, decoder or helper is executed; no arbitrary malformed data is used as a bug.',
 'sanitize.ts':'Full physical body reading for diagnostic clone, ordinary nested string/object/array and content-state propagation. This is not a complete secrets/security certification or adversarial-input campaign.',
 'native-process.ts':'Full physical body reading of the bounded observation data channel, actual frames.read consumer, accepted start/finish fields and record callback. Launcher, process/FD producer, provider/account/authority mechanisms are outside scope.',
 'context.ts':'Selected capture/settle and event value/state-to-write plumbing. Adjacent policy/timer/storage names are visible but their mechanisms, enforcement and runtime scheduling are not certified.',
 'types.ts':'Selected state/status type declarations only.',
 'native-frames.test.ts':'Ordinary legacy/concurrent UTF8 existing declaration and helper read through line46, no execution. Lines47–60 are adjacent malformed-input test display, excluded from semantic scope and no bug inferred from them.'}
files=[]
for p,row in read.items():
 display=union(row['selectedLineRanges']);semantic=([[1,46]] if p.endswith('native-frames.test.ts') else display);semset={i for a,z in semantic for i in range(a,z+1)}
 r=first[p];kind='test-declaration' if '.test.' in p else 'product'
 files.append({'path':p,'bytes':row['bytes'],'lines':row['lines'],'sha256':row['sha256'],'initialPinAtUTC':r['pinAtUTC'],'initialSemanticReadSha256':r['sha256'],'coverage':'full' if semantic==[[1,row['lines']]] else 'selected','selectedLineRanges':semantic,'semanticReadLineRanges':semantic,'displayedLineRanges':display,'semanticReadLines':len(semset),'displayedLines':sum(z-a+1 for a,z in display),'navigationLineRanges':union([[n,n] for n in nav.get(p,set())]),'navigationOnlyLineRanges':union([[n,n] for n in nav.get(p,set())-semset]),'sourceKind':kind,'scope':scopes[Path(p).name],'newUniqueCoverageClaimed':False})
for p in ['packages/core/src/model-traces/classification.ts','CODESHELL.md','AGENTS.md']:
 r=first[p];files.append({'path':p,'bytes':r['bytes'],'lines':r['lines'],'sha256':r['sha256'],'initialPinAtUTC':r['pinAtUTC'],'initialSemanticReadSha256':None,'coverage':'hash-only','selectedLineRanges':[],'semanticReadLineRanges':[],'displayedLineRanges':[],'semanticReadLines':0,'displayedLines':0,'sourceKind':'product' if p.endswith('classification.ts') else 'instruction','scope':'Canonical same-SHA R18 /files/7 explicit full static read; current body excluded before read. Old backend dynamic failure remains SKIP.' if p.endswith('classification.ts') else 'Unchanged previously read instruction reused by SHA; no new semantic reading.'})
metadata=load('history-gate-before-pins.json');h=load('history-projection.json');shared=h['sharedBatch']
ending=[]
for r in files:
 b=(root/r['path']).read_bytes();ending.append({'path':r['path'],'initialSha256':r['sha256'],'endingSha256':digest(b),'same':digest(b)==r['sha256'] and len(b)==r['bytes']})
me=[]
for r in metadata:
 b=(root/r['path']).read_bytes();me.append({'path':r['path'],'initialSha256':r['sha256'],'endingSha256':digest(b),'same':digest(b)==r['sha256']})
b=Path(shared['path']).read_bytes();me.append({'path':shared['path'],'initialSha256':shared['sha256'],'endingSha256':digest(b),'same':digest(b)==shared['sha256']})
assert all(x['same'] for x in ending+me)
put('ending-checks.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceRows':ending,'selectedMetadataRows':me,'allSame':True,'wholeHistoryInventoryRehashed':False,'newSourceSemanticReads':0})
product=sum(r['semanticReadLines'] for r in files if r['sourceKind']=='product');test=sum(r['semanticReadLines'] for r in files if r['sourceKind']=='test-declaration');display=sum(r['displayedLines'] for r in files)
counts={'sourceRows':len(files),'productSemanticFiles':5,'productFullFiles':3,'productSelectedFiles':2,'productHashOnlyFiles':1,'testSelectedFiles':1,'instructionHashOnlyFiles':2,'productSemanticLines':product,'testDeclarationSemanticLines':test,'displayedLines':display}
assert product==552 and test==46 and display==612
put('source-manifest.json',{'root':str(root),'rootReportedHead':'9874f8abdfce0ade5bb058d26e026b10f173a129','rootReportedBranch':'codex/audit/traces-notifications-resources-round63-20261018','GitVerified':False,'files':files,'counts':counts,'metadataFiles':metadata,'sharedHistoryBatch':shared,'historyGateRead':{'canonicalObject':'docs/audit-2026-10-17-round18/evidence/presentation-source-manifest.json#/files/7','canonicalReportRange':['docs/audit-2026-10-17-round18/presentation.md',15,36],'derivedLocatorObjectsRead':8,'derivedObjectsNotCanonicalFullProof':True},'scopeMeaning':'Physical full/selected body reading only for the bounded ordinary data contract; not first reading, unique new coverage or all-behavior/runtime certification. Navigation-only rows/ranges and adjacent display are separate.','testsExecuted':0,'productExecutions':0,'gitCalls':0,'networkCalls':0})
put('classification.json',{'formalFindings':[],'candidates':[],'newRelatedFindings':[],'counts':{'formal':0,'candidate':0,'newRelated':0},'result':'Finite static negative; no ordinary producer-consumer contradiction established.','oldFullGate':{'path':'packages/core/src/model-traces/classification.ts','canonical':'docs/audit-2026-10-17-round18/evidence/presentation-source-manifest.json#/files/7','scope':'full static read; not imported/executed','currentBodyReads':0},'ordinaryEvidence':[{'range':'native-frames.ts:58-83','observation':'Per-message id sequence accumulates raw chunks, final UTF8 decoding follows reassembly; assembled model_trace is validated before return. No runtime or broad transport correctness claim.'},{'range':'native-process.ts:164-188,126-152','observation':'Real data channel sends complete decoder strings into accept, then ordinary start/finish shape and projected input/output to record callback. Native launcher/writer and actual FD transport not audited.'},{'range':'sanitize.ts:24-79,96-145','observation':'Diagnostic clone is separate from source arrays/objects; bounded content and state accompany return value. No arbitrary secret formats or malformed DTOs used as findings.'},{'range':'context.ts:222-245,757-770,787-788','observation':'Actual capture and event plumbing consume sanitized value/state and feed the event writer; no store, timer, account or policy runtime validation.'}],'limits':['No concrete new normal-input counterexample established; finite0 is not proof of all valid traces, truncation/retention policy or secrets coverage.','Actual native producer/launcher, storage lifecycle, provider wire format and GUI consumers remain outside this packet.','Existing Core model-trace backend/i18n failed dynamic directions remain permanently skipped; static source and declaration reading are not replacement verification.'],'runtimeValidation':'none'})
put('diagnostics.json',{'firstErrors':[],'navigationSyntaxWarnings':{'artifact':'navigate-chain.first.stderr.txt','childExitCode':0,'meaning':'Python non-raw regex string emits invalid-escape SyntaxWarning; regex navigation completed, raw stderr preserved, method not rewritten or rerun.'},'noMatchNavigation':{'artifact':'chain-navigation.json','group':1,'exitCode':1,'meaning':'Heading regex required two spaces before test/it; actual native-frames.test declarations are top-level test. No match is metadata, not failed test/import; query not corrected/rerun. Later ordinary declaration read used already pinned actual filename.'},'displayTruncations':[],'oldFailureBoundary':'R18 original report32 keeps Core model-trace backend/i18n failed runtime directions skipped; no recovery experiment here.','productTestImportAttempts':0})
report=f'''# Model trace 普通数据链复核（预备168）

**0 正式 / 0 候选 / 0 新 related**。选定普通解码、诊断克隆和内容状态传递未建立新反例；不认证所有合法 trace、保留/截断策略或脱敏安全性。

Root 报告冻结 HEAD `9874f8abdfce0ade5bb058d26e026b10f173a129`，分支 `codex/audit/traces-notifications-resources-round63-20261018`；本作者 Git 0，无独立提交绑定。

- classification.ts 在正文前按原 R18 [gate证据](history-gate-objects.json) 排除：canonical /files/7 明确 full static read，bytes2106且同当前SHA。原 presentation.md15–36限定只静态分类/store/Host，旧 backend/i18n 动态失败 SKIP 保留。该文件本次仅hash，不算新增全文。
- native-frames90、sanitize147及实际消费者 native-process192行全文物理读；context199–248/740–807和types1–5选段。完整范围见 [source manifest](source-manifest.json)。普通数据上，decoder按messageId/part保留并最终解码；真实channel再送accept/record；sanitize返回独立clone及state，实际capture/event消费value/state。未建立正常producer违反这些数据映射的反例。launcher/真实FD producer未展开，不将测试构造器当生产证明。
- 本次 {product} 产品语义行 +{test} 既有普通测试声明行；总显示{display}行。test1–46为普通legacy/concurrent UTF8声明和辅助数据；47–60仅相邻非法输入声明显示，未计语义、未用作bug。3 product full、2 selected、1 product hash-only、1 test selected、2 instruction hash-only；不称首读、唯一新增或所有行为均已审完。
- Root171 [共享目标投影](history-projection.json) 纳冻62排63+，6669 MD/JSON、{h['jsonValueScalarsVisited']:,} JSON value scalars、errors=[]，含hidden/unignored/archive；三target57/60/84命中均低cap100，全保存。机器访问、派生coverage及import-preflight不证明旧全文或历史语义穷尽；实际原件gate为1 canonical object、原report22行，另8派生对象只作locator。

[分类与有限反证](classification.json) 保留未审边界。[Ending](ending-checks.json) 的9源/指令pins、3份选定历史材料及共享batch均同；未重新hash全6669历史。所有产品/helper/import/fixture/test/Buffer/clock/native/process/provider/network执行0，无真实trace或账号，无修复，仅写exact tmp。

首stdout/stderr/exit先持久化再展示；当前源输出无截断。导航有Python SyntaxWarning（child exit0）及test标题pattern未命中（rg exit1），原件和含义见 [diagnostics](diagnostics.json)，均非产品或测试失败，未修正重跑。
'''
(out/'report.md').write_text(report)
links=[{'target':target,'exists':(out/target).is_file()} for _,target in re.findall(r'\[([^\]]+)\]\(([^)]+)\)',report)]
assert all(r['exists'] for r in links)
for row in files:
 assert all(1<=a<=z<=row['lines'] for a,z in row['selectedLineRanges'])
 assert sum(z-a+1 for a,z in row['selectedLineRanges'])==row['semanticReadLines']
excount=0
for n in ['leaf-excerpts.json','chain-excerpts.json','supplement-excerpts.json']:
 for r in load(n):
  b=r['text'].encode();assert len(b)==r['bytes'] and digest(b)==r['sha256'];excount+=1
put('checks.json',{'sourceRows':9,'counts':counts,'classification':{'formal':0,'candidate':0,'newRelated':0},'reportLinks':links,'allLinksExist':True,'endingAllSame':True,'excerptRangeObjectsChecked':excount,'excerptBytesAndHashesValid':True,'productExecutions':0,'gitCalls':0})
print(json.dumps({'classification':'0/0/0','sourceRows':9,'productLines':product,'testDeclarationLines':test,'displayLines':display,'links':len(links),'endingAllSame':True},ensure_ascii=False))
