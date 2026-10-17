from pathlib import Path
import json,hashlib,re,subprocess,collections,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round121-coverage-refresh');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat();sha=lambda b:hashlib.sha256(b).hexdigest()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
# Preserve the first logical metadata-adapter failure, including its script and exact generated output bytes.
firsts=[]
for name in ['increment.py','increment-summary.json','increment-claims.json','unified-current-index.json']:
 p=O/name;b=p.read_bytes();firsts.append(dict(originalName=name,preservedAs=p.stem+'.first'+p.suffix,bytes=len(b),sha256=sha(b)));p.rename(O/(p.stem+'.first'+p.suffix))
save('metadata-diagnostics.json',dict(createdAt=now(),firstAttemptToolChunk='39a223',firstAttemptExitCode=0,firstAttemptObserved='acceptedClaims0 of511; NOT a valid no-increment result',firstFiles=firsts,diagnosis='Own metadata field normalizer removed digits from field names (sha256->sha), but source-hash allowlist retained sha256; source bindings were not recognized. This is reviewer metadata logic, not product or author-manifest rejection.',disposition='DEFERRED_UNPARSED. No retry or schema expansion this task; all511 incremental rows not semantically classified. Only reconstructed45 current exact-SHA carry-forward is publishable.',productOrAuthorMethodFailure=False,productExecutions=0,oldMethodExecutions=0,metadataPresentationTruncations=0))
base=json.loads((O/'base-reconstruction.json').read_text());inv=json.loads((O/'current-source-inventory.json').read_text());docs=json.loads((O/'increment-manifest-inventory.json').read_text());recpins=json.loads((O/'reconstruction-input-pins.json').read_text());cur={x['path']:x for x in inv['files']}
# Keep original purpose evidence by immutable claim references, not by flattening claims into a broader completeness assertion.
oldindexp='docs/audit-2026-10-17-round44/evidence/coverage-frontier/coverage-index.json';b=(R/oldindexp).read_bytes();oldindexpin=dict(path=oldindexp,bytes=len(b),sha256=sha(b),lines=len(b.splitlines()));oldindex=json.loads(b);oldrows={x['path']:(i,x)for i,x in enumerate(oldindex['files'])};transp='docs/audit-2026-10-17-round47/evidence/coverage-adapter/status-transitions.json';trans=json.loads((R/transp).read_bytes());trmap={x['path']:(i,x)for i,x in enumerate(trans['rows'])};proofs=[]
for p,x in cur.items():
 if x['carryForwardCoverage']=='unknown':continue
 pr=dict(path=p,sha256=x['sha256'],status=x['carryForwardCoverage'],frozen51Inventory='docs/audit-2026-10-17-round44/evidence/coverage-status/current-inventory.json',frozen45Transition=transp if p in trmap else None)
 if p in trmap:pr['transitionPointer']='/rows/'+str(trmap[p][0]);pr['transitionOriginalProofs']=trmap[p][1]['provenance']
 if p in oldrows:
  i,row=oldrows[p];pr['originalIndexDocument']=oldindexp;pr['originalIndexPointer']='/files/'+str(i);pr['originalFullClaimIds']=row.get('currentExplicitFullClaimIds',[]);pr['originalSelectedClaimIds']=row.get('currentExplicitSelectedClaimIds',[]);pr['claimTable']='docs/audit-2026-10-17-round44/evidence/coverage-frontier/coverage-claims.json'
 pr['purposePolicy']='Original referenced source-row purpose/scope and mechanism limits remain binding; no all-contract/full-behavior assertion.';proofs.append(pr)
save('frozen45-provenance.json',dict(createdAt=now(),oldIndexInput=oldindexpin,claimTableInterpretation='Claim IDs reference frozen original metadata without executing methods or re-reading12MB claims table. No new interpretation/upgrading of those scopes.',files=proofs))
save('increment-summary.json',dict(createdAt=now(),status='DEFERRED_UNPARSED',scope='Frozen46..53 canonical source-manifest-named JSON only;54 excluded even after docs-only integration',manifestDocuments=64,sourceRowsDiscovered=511,sourceRowsSemanticallyClassified=0,publishableIncrementCounts=None,publishableMerged46to53Counts=None,reason='Own metadata source-hash field adapter defect; first outputs preserved and withdrawn. Absence of recognized increments is NOT absence of later reading. Deferred rows are not semantically rejected.',followup='Any later incremental adaptation must be a separate task with canonical per-row purpose/range/SHA review; not needed for current reliable carry-forward status.'))
save('increment-claims.json',dict(createdAt=now(),status='DEFERRED_UNPARSED',classifiedClaims=[],rowsNotClassified=511,firstAttemptEvidence='increment-claims.first.json',notSemanticRejections=True))
save('unified-current-index.json',dict(createdAt=now(),status='PUBLISHABLE_FROZEN45_EXACT_SHA_CARRY_FORWARD_ONLY',rootReportedByteBaseline='0d2d5418b0b4821fdb11dc87e328fce7e1f2433e',rootLaterDocsOnlyHead='00c046367769349c1f5413e74c993b2c19ce8337',gitCertified=False,sourceSemanticReads=0,scope='Recovered frozen45 exact records, withdrawn on SHA drift;46..53 deferred/unparsed and54 excluded. Not a merged all-round semantic coverage census.',files=[dict(**x,publishableCurrentCoverage=x['carryForwardCoverage'])for x in inv['files']]))
# Ending byte checks only: no source text decode, AST, imports, methods, tests or Git.
sourceChanges=[]
for p,x in cur.items():
 raw=(R/p).read_bytes()
 if len(raw)!=x['bytes']or sha(raw)!=x['sha256']:sourceChanges.append(dict(path=p,currentBytes=len(raw),currentSha256=sha(raw),initialSha256=x['sha256']))
rgcmd=inv['filter'];endpaths=sorted(set(subprocess.run(rgcmd,cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()));inputChecks=[]
for x in recpins['files']+docs['files']+[oldindexpin]:
 raw=(R/x['path']).read_bytes();inputChecks.append(dict(path=x['path'],bytes=len(raw),sha256=sha(raw),matchesInitial=len(raw)==x['bytes']and sha(raw)==x['sha256']))
assert not sourceChanges;assert set(endpaths)==set(cur);assert all(x['matchesInitial']for x in inputChecks)
counts=base['carryForwardCounts'];assert counts==dict(collections.Counter(x['carryForwardCoverage']for x in cur.values()))
save('checks.json',dict(createdAt=now(),files=[],publishedStage='Frozen45 records only, exact current SHA carry-forward',sourceHashOnlyCount=len(cur),productBodyLinesRead=0,sourceEndingChanges=sourceChanges,sourcePathsAddedAtEnding=sorted(set(endpaths)-set(cur)),sourcePathsRemovedAtEnding=sorted(set(cur)-set(endpaths)),metadataInputChecks=inputChecks,allMetadataInputsUnchanged=True,frozen45Counts=base['frozen45Counts'],currentCarryForwardCounts=counts,transitionBaseErrors=base['transitionErrors'],incrementStatus='DEFERRED_UNPARSED',oldMethodsExecuted=0,productHelperFixtureTestReactNetworkNativeGitExecutions=0))
save('source-manifest.json',dict(createdAt=now(),files=[],hashOnlySourceInventory='current-source-inventory.json',hashOnlySourceCount=len(cur),sourceBodyDecodedOrExecuted=False,semanticSourceLines=0,metadataInputs='checks.json /metadataInputChecks',methodRead=dict(path='docs/audit-2026-10-17-round47/evidence/coverage-adapter/method.py',lines=[[1,298]],sha256='b4fc38e937b1d2dd1523c5fdf5f00e6cfdbcc71897ae744520b055711b6d274c',executed=False),reconstructionInputPins='reconstruction-input-pins.json',rangesAndPurposeReferences='frozen45-provenance.json',globalCoverageChanged=False,preciseUnreadOrCurrentUnfixedClaim=False,scope='User status metadata refresh, not independent whole-repository source review or behavior validation'))
report='''# 当前覆盖台账状态（保守迁移口径）

截至本次工作树字节，TS/TSX 路径 **4643** 个：有 **304 个明确完整阅读范围记录、168 个部分阅读记录、4171 个索引无法确认语义覆盖**。因此 **4339 个不能据这份台账标为完整范围**；这不是“从未阅读”或“还剩4339个文件要审”的精确计数，也不是未修 bug 数。完整记录仍受原阅读目的与机制边界限制，不表示所有合同、平台、运行行为已验证。

| 可复核阶段 | 完整范围记录 | 部分记录 | 无法确认 | 总数 |
| --- | ---: | ---: | ---: | ---: |
| 原冻结45的集合 | 304 | 169 | 4170 | 4643 |
| 原集合迁移当前相同SHA，撤销漂移绑定 | 304 | 168 | 4171 | 4643 |

恢复方法可行：[原47 method.py](#method)只读未执行；完整的 frozen51/current-inventory 加35条逐路径 status-transitions 恢复至冻结45，所有旧状态/SHA匹配、0 transition错误，并复现原summary。随后使用原相同 `rg --files --hidden` TS/TSX过滤，只读取bytes/SHA/splitlines，不解码或阅读产品正文。原45至当前8个TS/TSX路径SHA改变、0新增/删除；其中只有 MessageStream.tsx 原属部分记录，已撤销该1项，其余7项原本无法确认（含compress.ts及其test）。逐路径见[当前库存](current-source-inventory.json)、[重建与差集](base-reconstruction.json)、[保留的原范围/目的引用](frozen45-provenance.json)。

46–53增量本次 **尚未适配完成**，54排除。只定位并固定64份规范 source-manifest JSON、511个当前TS/TSX行；自有元数据hash字段normalizer去掉数字而allowlist仍带256，首次输出0/511是适配器逻辑缺陷，**不能解释成后续没有阅读或记录被语义拒绝**。[首诊断](metadata-diagnostics.json)保存原脚本和首次输出字节，原样标first；未执行第二次适配。活跃[increment状态](increment-summary.json)为 `DEFERRED_UNPARSED`、不发布合并数字，后续可单独继续。不强行处理MD-only、复杂ancestor限制、full显示/偶读、hash-only、旧full gate 或重复作者/reviewer记录。

<a id="method"></a>原method为 `docs/audit-2026-10-17-round47/evidence/coverage-adapter/method.py:1–298`，输入/输出均只读；未执行作者method或产品代码。原完整逐文件集合能够恢复，不需要重扫历史数百万scalar。分母包括tests/helpers和部分文档内TS证据，仅是原同过滤的TS/TSX宇宙；CSS、非TS和所有其他机制不在分母。MD-only与未回填46–53/54可能含更多实际阅读，不能从4171减去后续阅读行/文件数；同一路径、不同版本、选段重叠和正式化副本也不能简单相加。没有覆盖百分比、精确unread或当前unfixed断言。

Root给定当前字节基线0d2d5418…，此前读取上下文16c1a40…；本agent未查Git。Root随后通知正式54文档整合head00c04636…、产品同字节。[结束检查](checks.json)核4643个source hash与73个元数据输入全部未变；54即使已提交也未补入本次证据。发布集合见[统一当前索引](unified-current-index.json)，明确仅为旧45同SHA迁移；[source manifest](source-manifest.json)的产品语义files为空，Git/产品/helper/fixture/test/React/network/native执行均0。本包是用户状态核对，不是独立全仓复审；所有问题列表由Root正式问题清单另提供。
'''
(O/'report.md').write_text(report)
# The one in-document fragment is checked separately; other links are local packet links.
links=[]
for m in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',report):
 target=m.group(1)
 if target.startswith('#'):ok=('id="'+target[1:]+'"')in report;links.append(dict(target=target,exists=ok));continue
 q=(O/target).resolve();links.append(dict(target=target,exists=q.is_file(),insidePacket=q.is_relative_to(O.resolve())))
assert all(x['exists']for x in links)
save('report-links.json',dict(createdAt=now(),links=links,allValid=True))
receipt=[]
for p in sorted(O.iterdir()):
 if p.is_file()and p.name!='reviewer-receipt.json':
  raw=p.read_bytes();receipt.append(dict(path=p.name,bytes=len(raw),sha256=sha(raw)))
save('reviewer-receipt.json',dict(createdAt=now(),frozen=True,scope='Exact packet files excluding self-receipt; publishable frozen45 exact-current-SHA carry only;46..53 deferred',files=receipt))
for n in ['report.md','source-manifest.json','reviewer-receipt.json']:
 raw=(O/n).read_bytes();print(n,len(raw),sha(raw))
print(json.dumps(dict(packetFiles=len(receipt)+1,receiptFiles=len(receipt),localReportLinks=len(links),metadataInputChecks=len(inputChecks),sourceHashes=len(cur),counts=counts,increment='DEFERRED_UNPARSED',sourceEndingChanges=0,productBody=0,Git=0),ensure_ascii=False))
