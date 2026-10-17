from pathlib import Path
import json,hashlib,re,subprocess,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round109-web-format')
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(n,v): (O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def pin(p):
 b=(R/p).read_bytes();return dict(path=p,bytes=len(b),sha256=hashlib.sha256(b).hexdigest(),lines=len(b.splitlines()))
initial=json.loads((O/'initial-pins.json').read_text()); fallback=json.loads((O/'fallback-before-pin.json').read_text());history=json.loads((O/'history-inventory.json').read_text());canonical=json.loads((O/'canonical-evidence.json').read_text())
checks=[]
for row in initial['files']+[fallback]:
 q=pin(row['path']);q['matchesInitial']=all(q[k]==row[k] for k in ['bytes','sha256']);checks.append(q)
changed=[];missing=[]
for m in history['files']:
 p=R/m['path']
 if not p.exists():missing.append(m['path']);continue
 b=p.read_bytes()
 if len(b)!=m['bytes'] or hashlib.sha256(b).hexdigest()!=m['sha256']:changed.append(dict(path=m['path'],currentBytes=len(b),currentSha256=hashlib.sha256(b).hexdigest(),originalBytes=m['bytes'],originalSha256=m['sha256']))
paths=sorted(set(subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()))
def include(p):
 m=re.search(r'(?:^|/)audit-[^/]*-round(\d+)(?:/|$)',p);return not(m and int(m.group(1))>=53)
old={x['path'] for x in history['files']};current={p for p in paths if include(p)}
ending=dict(createdAt=now(),sourceAndInstructionPins=checks,historyOriginalCount=len(old),historyCurrentIncludedCount=len(current),historyChanged=changed,historyMissing=missing,historyAdded=sorted(current-old),historyRemoved=sorted(old-current),excludedCurrentPaths=[p for p in paths if not include(p)],productSHAIsByteMetadataOnly=True,gitExecuted=False)
save('ending-checks.json',ending)
save('metadata-diagnostics.json',dict(firstInventory=dict(toolChunk='20cc03',command='rg --files docs bugs -g *.md -g *.json',exitCode=0,displayTokenCap=100,reportedOriginalTokenCount=86235,reportedTotalOutputLines=5153,truncated=True,originalStdoutFileCaptured=False,evidence='Original tool result retains truncated presentation. This record is a diagnostic, not reconstructed byte-original stdout. A later metadata script captures inventory internally and emits only counts.',rerunScope='File-name metadata inventory only; no product execution'),otherMetadataCommandErrors=0,otherOutputTruncations=0,productExecutionFailures=0))
files=[];hashfiles=[]
for q in [initial['files'][2],fallback]:
 end=next(c for c in checks if c['path']==q['path'])
 hashfiles.append(dict(path=q['path'],bytes=q['bytes'],sha256=q['sha256'],lineCount=q['lines'],coverage='hash-only; same-SHA historical full gate excluded before current product body',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0,initialPinArtifact='initial-pins.json' if q==initial['files'][2] else 'fallback-before-pin.json',endingSha256=end['sha256'],matchesInitial=end['matchesInitial']))
manifest=dict(createdAt=now(),parentContext=initial['parentContext'],parentContextSource='Root-provided frozen context; no Git query',files=files,hashOnlyFiles=hashfiles,instructionPins=[dict(**x,coverage='hash-only this packet; prior full instruction read reused unchanged',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0)for x in initial['files'][:2]],gateDecisions=[dict(path=hashfiles[0]['path'],sha256=hashfiles[0]['sha256'],disposition='excluded-before-current-product-body',originalDocument=canonical['jsonObjects'][0]['path'],pointer='/files/10',explicitScope='Full static module; old project matching and i18n preflight directions not recovered, no import.'),dict(path=hashfiles[1]['path'],sha256=hashfiles[1]['sha256'],disposition='excluded-before-current-product-body',originalEvidence=[dict(document=canonical['jsonObjects'][1]['path'],pointer='/sources/3',review='whole-file'),dict(document=canonical['jsonObjects'][2]['path'],pointer='/sources/7',readScope='full')])],historicalMetadataSelected=canonical['markdown'],historicalCanonicalObjects=canonical['jsonObjects'],productSemanticLineCount=0,productDisplayedLineCount=0,testDeclarationLineCount=0,methodLimits=['Original canonical same-object path and SHA plus explicit whole-file/full static scope required; matching parent artifact hashes, inventory, no-row, unknown, rank and hash-only claims do not establish coverage.','Historical source-reading declarations are not current runtime behavior validation or a claim that either module has no bugs.','Broad machine-extracted history matches and 1254/110 direct-path objects were not all manually semantically read. Three original canonical objects are activated; other printed source-row/MD locator contexts do not add product coverage.','R5/R8 format full on SHA4e0f... is a different older version and is not used to bind current format.ts.'])
save('source-manifest.json',manifest)
save('validation.json',dict(createdAt=now(),classification=dict(formal=0,candidates=0,newRelated=0),oldFullExclusions=2,productSemanticLineCount=0,productDisplayedLineCount=0,testDeclarationLineCount=0,productExecutions=0,helperExecutions=0,fixtureExecutions=0,testExecutions=0,reactDOMTimerNativeModelNetworkExecutions=0,gitExecutions=0,globalCoverageUpdates=0,authorOldMethodsExecuted=0,metadataOnly=True,boundaries=['No current ordinary producer/consumer contract re-review because both permitted leaves were excluded before product body.','Old R14 userMessageDisplay wrong-relative-import dynamic direction remains SKIP; it was not restored through another entry point.']))
report='''# Web 格式化：读前同版本全文排除

本次 **0 正式 / 0 候选 / 0 新增关联**。两个允许目标均有明确同 SHA 的原始全文静态审查凭据，当前源码正文前排除；不再换第三个目标，没有重新验证普通消费者或宣称模块无缺陷。

- `packages/web/src/lib/format.ts`：140 行 / 5447 B，SHA `c1c2d582d623ba99a738b7d43c483358e6826cae24010ef7994b5d4708310f33`。原 R20 `evidence/root-source-manifest.json /files/10` 同对象明确 **Full static module**。保留“旧 project matching/i18n 失败预检方向不恢复、无 import”的限定。R49 既有 gate 是补充确认；R5/R8 此文件旧 full 的 SHA 不同，不能绑定当前版本。
- 唯一 fallback `packages/web/src/lib/userMessageDisplay.ts`：164 行 / 5926 B，SHA `628fb9130fccc1022c1448ccba8ed21fe145cfeb072167ab57f76411473a0391`。原 R5 `/sources/3` 明确 `review=whole-file`，原 R8 `/sources/7` 明确 `readScope=full`、同 SHA 和字节。更晚 hash-only/inventory 记录不会取消有效旧 full。旧 R14 错误相对 import 的失败动态方向继续 SKIP，未执行或恢复。

[原始对象与限定段](canonical-evidence.json)保留三份直接 canonical 对象及 25 行专门选读的历史 MD 元数据；其余命中展示只是定位/上下文，不折算成当前产品语义阅读。[源码清单](source-manifest.json)的 `files=[]`，产品 hash-only 两项，当前产品 semantic/display 均 0，测试声明 0；指令文件仅复核字节并复用先前同 SHA 阅读。

fresh [历史库存](history-inventory.json)含已冻结正式 52、排正式 53 及以后：**5150 = 1489 MD + 3661 JSON**；递归 JSON value 计 2430509 个字符串、3611347 个 scalar，键名不作 value 搜索。exact `archive` 路径段 162 份，substring `archive` 174 份，口径分别保留。path/SHA/叶名 gate 逐 MD 行及递归 JSON value 扫描；每查询保存前 100 个上下文和完整总数，不表示这些上下文均被人工全文读。format 命中 1760/712/1760，fallback 命中 211/56/854（path/SHA/叶名）；canonical 定向对象另提取，不受前 100 截断限制。unknown/no-row/hash-only 不是从未审查证明，也不更新全局覆盖计数。

[结束检查](ending-checks.json)核四项 source/instruction pin 和原 5150 份历史字节；原历史时点不倒填。首次直接打印 `rg` 文件名库存的展示被截断，退出 0，未保留原始 stdout 文件；[诊断](metadata-diagnostics.json)保存工具 chunk、上限和观察值，不伪造原始 raw。后续仅自有元数据读取、hash、JSON、范围与本包链接检查。

[validation](validation.json)中产品/helper/fixture/test/React/DOM/timer/native/model/network/Git 执行均 0。旧行为与运行结果不转移成此轮 pass；没有当前普通输入反例、实际消费者执行或整个 Web 正确性结论。冻结父上下文由 Root 给定为 `524c0827a480132119b637aa87e16f0eab9895f3`，本 agent 未查询 Git。
'''
(O/'report.md').write_text(report)
# Check local packet links only; ordinary code paths in prose are not new hyperlinks.
links=[]
for m in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',report):
 q=(O/m.group(1)).resolve();links.append(dict(target=m.group(1),exists=q.is_file(),insidePacket=q.is_relative_to(O.resolve())))
assert all(x['exists'] and x['insidePacket']for x in links)
assert all(x['matchesInitial']for x in checks)
assert not changed and not missing and not ending['historyAdded'] and not ending['historyRemoved']
save('checks.json',dict(createdAt=now(),classification=dict(formal=0,candidates=0,newRelated=0),links=links,allLinksValid=True,sourcePinsAllUnchanged=True,historyPinsAllUnchanged=True,currentProductBodyReads=0,productExecutions=0,gitExecutions=0,files=[]))
receipt=[]
for p in sorted(O.iterdir()):
 if p.is_file() and p.name!='artifact-receipt.json':
  b=p.read_bytes();receipt.append(dict(path=p.name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
save('artifact-receipt.json',dict(createdAt=now(),frozen=True,scope='Exact packet files excluding this self-receipt; no product or Git execution',files=receipt))
for name in ['report.md','source-manifest.json','artifact-receipt.json']:
 b=(O/name).read_bytes();print(name,len(b),hashlib.sha256(b).hexdigest())
print(json.dumps(dict(packetFiles=len(receipt)+1,receiptFiles=len(receipt),links=len(links),sourceInstructionPins=len(checks),historyFiles=len(old),excludedCurrentPaths=len(ending['excludedCurrentPaths']),classification='0/0/0',currentProductBodyLines=0),ensure_ascii=False))
