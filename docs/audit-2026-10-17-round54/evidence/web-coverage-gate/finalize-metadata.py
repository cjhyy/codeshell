from pathlib import Path
import hashlib,json,datetime,re,subprocess
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round115-output-coverage');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def hashrow(p):
 b=(R/p).read_bytes();return dict(path=p,bytes=len(b),sha256=hashlib.sha256(b).hexdigest(),lines=len(b.splitlines()))
# Capture only historical metadata already selected for the gate; never read current product text.
md=[]
for p,ns in [('docs/audit-2026-10-17-round29/root-report.md',[5]),('docs/audit-2026-10-17-round29/evidence/review-root-runtime.md',[11]),('docs/audit-2026-10-17-round7/root-metadata.md',[11])]:
 b=(R/p).read_bytes();ls=b.decode().splitlines();rows=[dict(line=n,text=ls[n-1])for n in ns];md.append(dict(path=p,bytes=len(b),sha256=hashlib.sha256(b).hexdigest(),selectedLineRanges=[[n,n]for n in ns],selectedLines=rows))
 print(json.dumps(dict(document=p,selectedLines=rows),ensure_ascii=False))
save('selected-history-metadata.json',dict(createdAt=now(),purpose='Original MD gate qualifiers only; no source body execution or new semantic product coverage',files=md))
first=json.loads((O/'initial-pins.json').read_text());fallback=json.loads((O/'fallback-before-pin.json').read_text());history=json.loads((O/'history-inventory.json').read_text());canonical=json.loads((O/'canonical-evidence.json').read_text());pins=first['files']+[fallback];ending=[]
for x in pins:
 q=hashrow(x['path']);q['matchesInitial']=q['bytes']==x['bytes']and q['sha256']==x['sha256'];ending.append(q)
changed=[];missing=[]
for x in history['files']:
 p=R/x['path']
 if not p.exists():missing.append(x['path']);continue
 b=p.read_bytes();sha=hashlib.sha256(b).hexdigest()
 if len(b)!=x['bytes']or sha!=x['sha256']:changed.append(dict(path=x['path'],originalBytes=x['bytes'],originalSha256=x['sha256'],currentBytes=len(b),currentSha256=sha))
paths=sorted(set(subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()))
def include(p):
 m=re.search(r'(?:^|/)audit-[^/]*-round(\d+)(?:/|$)',p);return not(m and int(m.group(1))>=54)
old={x['path']for x in history['files']};cur={p for p in paths if include(p)}
save('ending-checks.json',dict(createdAt=now(),sourceAndInstructionPins=ending,historyOriginalCount=len(old),historyCurrentIncludedCount=len(cur),historyChanged=changed,historyMissing=missing,historyAdded=sorted(cur-old),historyRemoved=sorted(old-cur),excludedCurrentPaths=[p for p in paths if not include(p)],gitExecuted=False))
sourceRows=[]
for p in [first['files'][2],fallback]:
 sourceRows.append(dict(path=p['path'],bytes=p['bytes'],sha256=p['sha256'],lineCount=p['lines'],coverage='hash-only; explicit same-SHA canonical old-full exclusion before body',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0,firstPinUTC=p['pinnedBeforeBodyUTC'],initialPinArtifact='initial-pins.json'if p==first['files'][2]else'fallback-before-pin.json',endingSha256=next(x['sha256']for x in ending if x['path']==p['path']),matchesInitial=True))
save('source-manifest.json',dict(createdAt=now(),parentContext=first['parentContext'],parentContextSource='Root-provided frozen context; no Git query',files=[],hashOnlyFiles=sourceRows,instructionPins=[dict(**p,coverage='hash-only in this packet; same SHA as prior full instruction reading, reused',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0)for p in first['files'][:2]],gateDecisions=[dict(path=sourceRows[0]['path'],sha256=sourceRows[0]['sha256'],disposition='old-full-excluded-before-product-body',originalDocument=canonical['objects'][0]['document'],pointer='/files/0',coverage='full',originalSelectedLineRanges=[[1,168]],qualifiers='Static source only; no cursor/epoch/identity/journal/reconnect/auth or runtime validation'),dict(path=sourceRows[1]['path'],sha256=sourceRows[1]['sha256'],disposition='old-full-excluded-before-product-body',originalDocument=canonical['objects'][1]['document'],pointer='/sources/10',readScope='full',originalReadRanges=None,originalFrozenAndInspectedMainShaMatch=True,qualifiers='Original full declaration activated only for this exact leaf; no assertion about all locale text, components or language-switch behavior')],originalCanonicalObjects=canonical['objects'],historicalMarkdownSelected=md,productSemanticLineCount=0,productDisplayedLineCount=0,testDeclarationLineCount=0,newFullCoverageClaims=0,globalCoverageUpdates=0,limits=['No ordinary new concrete issue was supplied or discovered before the same-SHA full gate, so neither product body nor ordinary consumer/test was reopened.','Hash/unknown/no-row/rank are not unread evidence; precise original whole-file/full scope and same-object SHA required.','No broader protocol, current correctness, runtime pass or global whole-repository coverage conclusion.']))
save('validation.json',dict(createdAt=now(),classification=dict(formal=0,candidates=0,newRelated=0),oldSameShaFullExclusions=2,productSemanticLineCount=0,productDisplayedLineCount=0,testDeclarationLineCount=0,productExecutions=0,helperExecutions=0,fixtureExecutions=0,testExecutions=0,reactDOMClockNetworkNativeModelExecutions=0,gitExecutions=0,authorOldMethodsExecuted=0,guardedTestPlan='None proposed: no new concrete ordinary-input issue after the pre-body gate. No failed dynamic direction retried.',metadataCommandErrors=0,metadataOutputTruncations=0))
report='''# Web output coverage：同版本全文记录门槛

本包 **0 正式 / 0 候选 / 0 新增关联**，两个允许目标都在当前产品正文前排除，未换第三个题。产品语义/显示、测试声明及所有产品/helper/fixture/test/React/DOM/clock/network/native/model/Git 执行均 **0**；没有新的普通输入反例，因此未提出或运行 guarded 测试。

- `packages/web/src/lib/outputCoverage.ts`：168行 / 5644B，SHA `34493ef24963c7c78b75ca13e38d25c1f63186f6f0246c9caedcd03034219fa5`。原 R29 `evidence/root-source-manifest.json /files/0` 同对象明确 `coverage=full`、1–168、168 covered lines，首次与结束 SHA 一致。原 root-report.md5 和独立 review-root-runtime.md11也明确全文；保留 cursor/epoch/identity/journal 仅静态边界、未验证整个协议的限定。R5 whole-file、R23 full exploratory 是更早佐证，不代替本次的原范围/SHA 联合判断。
- 唯一 fallback `packages/web/src/lib/uiLanguage.ts`：36行 / 1366B，SHA `06b7ae6b538c77ee19c616b6521c0a7d73eb68ece7ac561a76873c37f790dcd2`。原 R8 `evidence/web-source-manifest.json /sources/10` 明确 `readScope=full`、同 SHA/字节/行数，并且原 frozen 与 inspected-main SHA 同值。R7 root-metadata.md11为相邻读取限定，未声称所有文案、caller 或语言切换正确。

[canonical 原对象](canonical-evidence.json)与[选读 MD 限定](selected-history-metadata.json)保留直接凭据。[源码清单](source-manifest.json)为 `files=[]`、产品 hash-only 两项；本轮只 hash/行数与历史元数据，不重新认证 seq/range、reconnect、IO、auth 或 locale 行为。旧 i18n、TUI、fixture/import 等失败动态方向继续 SKIP。full 是旧静态阅读范围，不是“没有 bug”或当前运行通过；unknown/no-row/hash-only 也不是未读证据，未修改全局覆盖计数。

fresh [历史库存](history-inventory.json)纳已冻正式53、排正式54及以后：**5311 = 1500 MD + 3811 JSON**，递归 JSON value 2575070 strings / 3824469 scalars；键名不作 value 搜索。exact `archive` 路径段162份、substring174份分别记录。outputCoverage path/SHA/叶名命中66/50/430，uiLanguage为31/13/83；每query cap100、单value保存上下文cap1800字符，并保留原长度/value SHA和完整总数。直接 canonical 对象另提取，未因上下文cap偷升级，也不声称所有机器命中均人工全文阅读。

[结束检查](ending-checks.json)核四个 source/instruction pin 及原5311历史字节，原时点不倒填；两个指令文件本轮 hash-only，复用先前同 SHA 全文阅读。元数据命令失败0、输出截断0；只执行了本 agent 的 stdlib 文件/hash/JSON/链接检查，见[validation](validation.json)。Root给定冻结父上下文 `16c1a40c7e3f0cf7701fccd723293bfb1291f105`，本 agent 未查询 Git。没有重新审查整个 Web，也没有给出精确未读/未修数量。
'''
(O/'report.md').write_text(report)
links=[]
for m in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',report):
 q=(O/m.group(1)).resolve();links.append(dict(target=m.group(1),exists=q.is_file(),insidePacket=q.is_relative_to(O.resolve())))
assert all(x['exists']and x['insidePacket']for x in links)
assert all(x['matchesInitial']for x in ending)
assert not changed and not missing and not(cur-old)and not(old-cur)
save('checks.json',dict(createdAt=now(),files=[],sourcePins=4,sourcePinsAllUnchanged=True,historyFilesChecked=len(old),historyAllUnchanged=True,localLinks=links,allLinksValid=True,classification=dict(formal=0,candidates=0,newRelated=0),oldFullExclusions=2,currentProductBodyLines=0,testDeclarationLines=0,productExecutions=0,gitExecutions=0,metadataCommandErrors=0,metadataOutputTruncations=0))
rows=[]
for p in sorted(O.iterdir()):
 if p.is_file()and p.name!='artifact-receipt.json':
  b=p.read_bytes();rows.append(dict(path=p.name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
save('artifact-receipt.json',dict(createdAt=now(),frozen=True,scope='Exact packet files excluding this self-receipt; historical full gate metadata only, no current product body or Git',files=rows))
for n in ['report.md','source-manifest.json','artifact-receipt.json']:
 b=(O/n).read_bytes();print(n,len(b),hashlib.sha256(b).hexdigest())
print(json.dumps(dict(packetFiles=len(rows)+1,receiptFiles=len(rows),links=len(links),sourcePins=4,historyFiles=len(old),excludedCurrentPaths=len([p for p in paths if not include(p)]),classification='0/0/0',productBody=0),ensure_ascii=False))
