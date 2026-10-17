from pathlib import Path
import json,hashlib,datetime,re,subprocess
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round162-user-status')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,d):(O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def load(n):return json.loads((O/n).read_text())
at=datetime.datetime.now(datetime.timezone.utc).isoformat();pins=load('input-pins.json')['files'];cs=load('candidate-input-pins.json')['formalRootCandidateFiles'];end=[]
for x in pins+cs:
 p=Path(x['path']);p=p if p.is_absolute() else R/p;b=p.read_bytes();end.append({'path':str(p),'initialSha256':x['sha256'],'endingSha256':h(b),'sameBytesAndSha256':len(b)==x['bytes'] and h(b)==x['sha256']})
r=subprocess.run(['rg','--files','-g','*.ts','-g','*.tsx'],cwd=R,capture_output=True);first=(O/'inventory-first.stdout').read_bytes();sameNames=set(r.stdout.decode().splitlines())==set(first.decode().splitlines());assert r.returncode==0 and sameNames
save('ending-checks.json',{'atUTC':at,'metadataFiles':end,'all59InputPinsSame':all(x['sameBytesAndSha256'] for x in end),'filenameOnlyEndingCheck':{'exitCode':r.returncode,'names':len(r.stdout.decode().splitlines()),'sameNameSetAsFirst':sameNames,'stdoutSha256':h(r.stdout)},'sourceBytesOrBodyRead':False,'productExecution':0,'git':0})
save('source-manifest.json',{'atUTC':at,'role':'Read-only historical issue/coverage status metadata reviewer; original154 author freshly recounts own frozen index, not a new independent semantic source review','files':[],'metadataFiles':pins+cs,'filenameInventoryArtifact':'current-ts-filename-inventory.json','productSourceBodyRead':0,'productSourceBytesRead':0,'productExecution':0,'git':0,'scope':'Formal58 catalog/MD118; frozen154 index; formal root candidate JSON through60; mutable61 not included, no history cause or current-fix reassessment.'})
save('diagnostics.json',{'firstOutputs':['status-first.stdout','status-first.stderr','status-first-exit.json','inventory-first.stdout','inventory-first.stderr','inventory-first-exit.json'],'firstExtractionExit':0,'firstInventoryExit':0,'initialComparisonDifferences':{'count':2,'record':'checks.first.json','clarification':'A11 bracketed priority+dated evidence qualifier and CHAT-R58-01 relative canonical link, correctly normalized later. Not original-record inconsistency or product failure.','recordedMethod':'catalog-normalization.json'},'firstCandidateSchemaDisplay':{'chunk':'63d3e7','originalTokens':4056,'maxOutputTokens':2600,'lines':77,'handling':'First tool presentation truncated; no all-object human semantic review claimed. Standard-library extraction preserves every original object into JSON, counts/missing fields unchanged.'},'productAttempts':0,'testsRun':0,'git':0})
report='''# prep162：118正式历史记录、历史候选与覆盖口径

完整精简列表在 [all118-historical-findings.txt](all118-historical-findings.txt)，逐条原ID/priority/title/sourceRound/canonical字段在 [JSON](all118-historical-findings.json)。正式58 catalog和ALL-ISSUES均118条、118唯一ID，45 P2 /73 P3；ID/级别/规范化标题/canonical来源逐项一致。**118是正式历史记录，不是当前未修数，也不是首次不同根因数。** 本包不自动加入Root尚未归档的formal61新条目。

另从正式根候选文件6–60提取55份 candidates.json：42条出现、42原ID唯一、无重复ID/无匿名条目；每份声明count与数组长度一致。详见 [candidate-history-list.md](candidate-history-list.md)与[完整原对象JSON](candidate-history-list.json)。原status/title/summary/hypothesis及缺失null均保留，SKIP/未证实/后来source-addressed等不改判；其它staticNotPromoted/alias数组单列保留，不混入42。**这42不是已确认数或当前活跃候选数，不能和118相加当当前未解决问题总数。** 没有重新审原因、去重根因或判断当前存活。

覆盖以冻结154更新索引重新机器计数：原4643路径中355 full、354 selected、3934 unknown，合计4643；**未full总4288 =354部分+3934无法确认完整范围**。可直接向用户说：“还有4288条路径没有完整范围记录，但这不是精确未读/尚未审完文件数，也无法推算剩余bug数。” full同样只是原用途下完整语义记录，不是所有机制/平台/运行时验证。

独立实际 `rg --files -g '*.ts' -g '*.tsx'` 只做文件名库存，当前4644个唯一名；与154原4643集合差分恰多 `docs/audit-2026-10-17-round57/evidence/static-path.test.ts`，无删除。它是旧审查证据fixture，分母外单列，不是新产品全文，不改变上述4643/4288口径。见[差分/覆盖](coverage-status.json)、[全部文件名](current-ts-filename-inventory.json)及[首次filename stdout](inventory-first.stdout)。没有打开产品/fixture源码或执行测试。

原ALL-ISSUES第5行仍为当时304/168/4171及46+待回填旧口径；本包只读核对，不修改旧文件，向用户说明覆盖时应使用后来的冻结154355/354/3934。旧表的历史时点不当作新索引计数错误。

首次提取[stdout](status-first.stdout)/[stderr](status-first.stderr)/[exit](status-first-exit.json)、filename[exit](inventory-first-exit.json)均先保存后看，exit0。初始标题/link比较有两项表示差异：A11带`[P2，静态确认]`前缀；最新条目用相对`findings.json`。经原优先级前缀/相对路径规范化后118全部一致，原[首检查](checks.first.json)和[更正说明](catalog-normalization.json)保留。候选schema首次宽展示被tool截断，未把未见内容当语义审核；机器按原对象完整提取，记录于[诊断](diagnostics.json)。

[输入pins](input-pins.json)、[55候选pins](candidate-input-pins.json)、[当前检查](checks.json)、[结束核对](ending-checks.json)与[metadata manifest](source-manifest.json)保存；59份原输入均同字节，ending文件名集合仍4644同名。154原件和仓库完全不改。产品语义files=[]、产品/fixture/test/Git/native/network0。[自排除receipt](artifact-receipt.json)用于冻结。
'''
(O/'report.md').write_text(report);links=re.findall(r'\]\(([^)]+)\)',report);assert all((O/x).is_file() for x in links if x!='artifact-receipt.json')
files=[]
for p in sorted(O.iterdir()):
 if p.is_file() and p.name!='artifact-receipt.json':
  b=p.read_bytes();files.append({'path':p.name,'bytes':len(b),'sha256':h(b)})
save('artifact-receipt.json',{'frozenUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'role':'Read-only user-status metadata extraction/count verification','files':files})
for x in files:
 b=(O/x['path']).read_bytes();assert len(b)==x['bytes'] and h(b)==x['sha256']
assert all((O/x).is_file() and (O/x).resolve().is_relative_to(O.resolve()) for x in links)
print('ARTIFACTS',len(files)+1,'ROWS',len(files),'LINKS',len(links))
for n in ['report.md','source-manifest.json','artifact-receipt.json','all118-historical-findings.txt','candidate-history-list.json','candidate-history-list.md']:
 b=(O/n).read_bytes();print(n,len(b),h(b))
