from pathlib import Path
import hashlib,json,re,subprocess,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round119-chat-lifecycle');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
first=json.loads((O/'initial-pins.json').read_text());fb=json.loads((O/'fallback-before-pin.json').read_text());history=json.loads((O/'history-inventory.json').read_text());can=json.loads((O/'canonical-evidence.json').read_text());ending=[]
for x in first['files']+[fb]:
 b=(R/x['path']).read_bytes();sha=hashlib.sha256(b).hexdigest();ending.append(dict(path=x['path'],bytes=len(b),sha256=sha,matchesInitial=len(b)==x['bytes']and sha==x['sha256']))
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
rows=[]
for p in [first['files'][2],fb]:
 rows.append(dict(path=p['path'],bytes=p['bytes'],sha256=p['sha256'],lineCount=p['lines'],coverage='hash-only; explicit original same-SHA full gate exclusion before current body',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0,firstPinUTC=p['pinnedBeforeBodyUTC'],initialPinArtifact='initial-pins.json'if p==first['files'][2]else'fallback-before-pin.json',endingSha256=next(x['sha256']for x in ending if x['path']==p['path']),matchesInitial=True))
save('source-manifest.json',dict(createdAt=now(),parentContext=first['parentContext'],parentContextSource='Root-provided fixed product context; no Git query',files=[],hashOnlyFiles=rows,instructionPins=[dict(**p,coverage='hash-only this packet; earlier same-SHA full instruction reading reused',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0)for p in first['files'][:2]],gateDecisions=[dict(path=rows[0]['path'],sha256=rows[0]['sha256'],disposition='old-full-excluded-before-current-product-body',originalDocument=can['objects'][0]['document'],pointer='/files/9',originalScope=can['objects'][0]['row']['scope'],lineCount=28,qualifiers='Static leaf/full helper only; old Mattermost Markdown candidate untested/skipped, no lifecycle/gateway/runtime correctness inference'),dict(path=rows[1]['path'],sha256=rows[1]['sha256'],disposition='old-full-excluded-before-current-product-body',originalDocument=can['objects'][1]['document'],pointer='/files/6',originalScope=can['objects'][1]['row']['scope'],supportingOriginalDocument=can['objects'][3]['document'],supportingPointer='/files/5',supportingOriginalScope=can['objects'][3]['row']['scope'],lineCount=93,originalReadCommandUpperBoundMention=120,originalDeclaredDisplayedCompleteLines=93,qualifiers='Original wording retained: command120 is not silently normalized into new range or line count; explicit complete93 and independent original full-helper declaration jointly support exclusion, no bytes loader/materialization runtime inference')],originalCanonicalObjects=can['objects'],historicalMarkdownSelected=can['markdown'],productSemanticLineCount=0,productDisplayedLineCount=0,testDeclarationLineCount=0,newFullCoverageClaims=0,globalCoverageUpdates=0,limits=['No current source body, tests, producer/adapter/caller was reopened after both permitted leaves met the explicit same-SHA full gate.','Filename lifecycle is not evidence that this packet reviewed start/stop/cleanup/callback/error contracts. Old N01 path/line locators are not automatically same-version or same-cause conclusions.','Unknown/no-row/hash-only is not unread evidence. Existing full source reading is not current behavior validation or a claim that the module has no bugs.']))
save('validation.json',dict(createdAt=now(),classification=dict(formal=0,candidates=0,newRelated=0),oldSameShaFullExclusions=2,productSemanticLineCount=0,productDisplayedLineCount=0,testDeclarationLineCount=0,productExecutions=0,helperExecutions=0,fixtureExecutions=0,testExecutions=0,chatGatewayAccountExternalMessageNetworkNativeProcessExecutions=0,gitExecutions=0,authorOldMethodsExecuted=0,guardedTestPlan='None proposed: no concrete new ordinary-input issue after the pre-body gate; old dynamic directions remain skipped',metadataCommandErrors=0,metadataOutputTruncations=0))
report='''# Chat lifecycle：读前历史全文门槛

本包 **0 正式 / 0 候选 / 0 新增关联**。主目标与唯一 fallback 均按原 canonical 同 SHA 的明确全文记录在当前正文前排除，不选择第三个文件。本次没有进入当前启动、停止、清理、callback/error 或 adapter/caller 源码合同，不能称这些机制已复核或正确。

- `packages/chat/src/lifecycle.ts`：28行 / 824B，SHA `cdf93e75be321a483b0b9d8339cbefe87b9e211549dfdda58f348ef1ab010d46`。原 R20 `evidence/root-source-manifest.json /files/9` 明确 **Full static leaf**，同对象字节/SHA/行数匹配；原 R11 `chat-source-manifest.json /files/9` 为 **full helper read; format candidate not tested**。原 chat.md21记录 Mattermost Markdown button URL/标签旧静态候选及官方资料首次读取失败后 SKIP；本包没有恢复该方向，也不按文件名把旧 helper 阅读升级成生命周期运行证明。
- 唯一 fallback `packages/chat/src/attachments.ts`：93行 / 3512B，SHA `58a2c3b5b566db4d7d3dc1a74bedc371c74972368fae3d9dbf6d400fcd29fc82`。原 R11 `/files/5` 明确 **full ordinary metadata helper read; no bytes loading execution**，frozen/current SHA 同值；原 R20 `/files/6` 明确读取命令到120而实际 **complete 93-line file**。原120命令上限与93实际完整声明分别保留，未静默正规化超 EOF 范围，也未把 loader/bytes/materialization 当作运行验证。

[canonical 原对象与 MD 限定](canonical-evidence.json)保留四个原 source-row 对象和8行专门选读的历史 MD 元数据。R43较晚 hash-only/inventory 不抹去原 full，也不另增加覆盖。旧 N01 只因 path/line 命中不自动认定当前同版本或同因，未重新打开其旧平台消息/队列/持久化方向。[源码清单](source-manifest.json)的 `files=[]`、两个产品 hash-only，semantic/display/test declaration 都0；指令文件本轮只 hash并复用先前同 SHA 阅读。没有普通新反例，因此没有提出或执行 guarded fake 测试计划。

fresh [历史库存](history-inventory.json)纳已冻结正式53、排正式54及以后：**5311 = 1500 MD + 3811 JSON**，recursive JSON values计2575070 strings /3824469 scalars，不把键名当值文本。exact archive路径段162份、substring174份分开。lifecycle path/SHA/叶名命中48/24/119，attachments为45/45/875；每query保存前100上下文，单值cap2000字符并保留原长度/value SHA，完整总数另存，直接 canonical对象不受前100 cap限制。未声称所有机器命中均人工全文读；unknown/no-row/hash不是未读证明，未更新全局覆盖或未修计数。

[ending](ending-checks.json)核四项 source/instruction pins与原5311历史字节；原时点不倒填。产品/helper/fixture/test/Chat/gateway/账户/外部消息/network/native/process/Git 执行均0；未读真实用户数据，未修产品，旧失败动态保持SKIP，见[validation](validation.json)。元数据命令错误0、展示截断0。父上下文 `16c1a40c7e3f0cf7701fccd723293bfb1291f105` 由Root给定，本 agent未查Git。旧全文记录仅支持本次排除门槛，不证明整个Chat无bug。
'''
(O/'report.md').write_text(report)
links=[]
for m in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',report):
 q=(O/m.group(1)).resolve();links.append(dict(target=m.group(1),exists=q.is_file(),insidePacket=q.is_relative_to(O.resolve())))
assert all(x['exists']and x['insidePacket']for x in links)
assert all(x['matchesInitial']for x in ending)
assert not changed and not missing and not(cur-old)and not(old-cur)
save('checks.json',dict(createdAt=now(),files=[],sourcePins=4,sourcePinsAllUnchanged=True,historyFilesChecked=len(old),historyAllUnchanged=True,localLinks=links,allLinksValid=True,classification=dict(formal=0,candidates=0,newRelated=0),oldFullExclusions=2,currentProductBodyLines=0,testDeclarationLines=0,productExecutions=0,gitExecutions=0,metadataCommandErrors=0,metadataOutputTruncations=0))
receipts=[]
for p in sorted(O.iterdir()):
 if p.is_file()and p.name!='artifact-receipt.json':
  b=p.read_bytes();receipts.append(dict(path=p.name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
save('artifact-receipt.json',dict(createdAt=now(),frozen=True,scope='Exact packet files excluding this self-receipt; historical source-full gate metadata only, no current product body or Git',files=receipts))
for n in ['report.md','source-manifest.json','artifact-receipt.json']:
 b=(O/n).read_bytes();print(n,len(b),hashlib.sha256(b).hexdigest())
print(json.dumps(dict(packetFiles=len(receipts)+1,receiptFiles=len(receipts),links=len(links),sourcePins=4,historyFiles=len(old),excludedCurrentPaths=len([p for p in paths if not include(p)]),classification='0/0/0',productBody=0),ensure_ascii=False))
