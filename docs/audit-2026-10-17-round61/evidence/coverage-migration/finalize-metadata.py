from pathlib import Path
import json,hashlib,datetime,re,collections
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round154-coverage-migration')
def h(b):return hashlib.sha256(b).hexdigest()
def load(n):return json.loads((O/n).read_text())
def save(n,d):(O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def artifact(n):
 b=(O/n).read_bytes();return {'path':n,'bytes':len(b),'sha256':h(b)}
at=datetime.datetime.now(datetime.timezone.utc).isoformat();initial=load('initial-pins.json');s=load('migration-summary.json');a=load('accepted-claims.json')['claims'];t=load('transitions.json')['statusTransitions'];by={x['claimId']:x for x in a};newfull=[x for x in t if x['to']=='full'];testfull=sum(by[x['representativeClaimId']]['testDeclarationOnly'] for x in newfull);manifestpins=load('manifest-inventory-pins.json')['metadataFiles'];oldpins=load('old-first-preservation-pins.json')['files'];oldextra=load('old-first-extra-pins.json')['files'];meta=[{**initial['files'][2],'readMode':'Original4643 per-path status reconstruction, metadata only'}]+[{**x,'readMode':'Standard-library JSON metadata parsing; only primary row fields/scope inspected, no source excerpts/body expanded'} for x in manifestpins]+[{**x,'readMode':'Old first outcome/diagnosis JSON metadata read, not method execution'} for x in oldpins if x['path'].endswith('.json')]
oldhash=[x for x in oldpins if x['path'].endswith('.py')]+oldextra
save('source-manifest.json',{'atUTC':at,'role':'Metadata-only conservative canonical46–60 coverage migration; not product source reviewer/runtime validator','files':[],'metadataFiles':meta,'instructionHashOnly':[initial['files'][0],initial['files'][1]],'oldFirstFailureHashOnly':oldhash,'sourceByteInventoryArtifacts':[artifact('current-source-inventory.json'),artifact('ending-source-inventory.json')],'sourceInventoryMode':'4643 original paths hashed in bulk as raw bytes/line counts only, no product semantic body interpretation. Not flattened into files/hashOnlySourceRows. Extra round57 evidence TS fixture separate in inventory, outside denominator.','rootReportedBaselineOnly':initial['rootReportedBaselineOnly'],'gitCertified':False,'methodsExecuted':['current-inventory.py raw byte inventory','migrate-coverage.py independent metadata adapter once','preserve-constraints.py metadata provenance annotation without reclassification','verify-migration.py independent metadata pointer/range/index checks','ending-inventory.py raw byte ending inventory','finalize-metadata.py own metadata receipt'],'oldMethodsExecuted':False,'productSourceSemanticReads':0,'productImportsHelpersTestsNativeNetworkGit':0,'schemaScope':'Only77 nonempty standard canonical .files lists in formal46–60.15 aggregate binding-only manifests/17empty gates/2inactive snapshots add no reading. No old archive/MD-only/other schema reclassification.','fullMeaning':'Full is explicit whole source text semantic reading for original stated ordinary purpose, not all behaviors, transitive mechanisms, platforms or runtime validation. Test declarations remain declarations, never pass.'})
save('metadata-presentation-diagnostics.json',{'old55FirstFailure':{'preservedOriginals':'old-first-preservation-pins.json and old-first-extra-pins.json','observedOutcome':'0 accepted of511 was normalizer bug, not valid absence of increments','rootCause':'Old normalizer removed digits sha256→sha while allowlist kept sha256. Old method not executed/modified; original first artifacts remain same bytes.'},'ownInitialSchemaProbe':{'toolChunk':'2f3edb','observation':'Generic coverage/status lookup printed None4643; actual schema is publishableCurrentCoverage.','handling':'Schema reconnaissance saved in schema-probe-diagnostic.json, then original304/168/4171 reproduced before migration. Not a migration no-increment result or product failure.'},'ownFirstMigration':{'receipt':'migration-first-exit.json','exitCode':0,'output':'migration-first.stdout','stderr':'migration-first.stderr','meaning':'509 applicable rows all bound direct sha256;495 current semantic rows accepted, oldSHA14 separately rejected. First results preserved before constraint annotation.'},'ownPresentationTruncation':{'toolChunk':'ecbc1c','originalTokens':7185,'maxOutputTokens':4700,'lines':125,'handling':'First warning retained. No missing middle counted as human read; all51 full representative purposes/pointers later displayed in complete bounded chunks5ef3cf and382646. Not a product failure/rerun.'},'constraintAnnotation':{'firstAcceptedClaims':'accepted-claims.first.json','changes':'Original row/doc purpose/limits copied, one absent direct purpose supplemented from oldCoverageLimitation/category; no classification/count changes.','record':'constraint-preservation.json'},'sourceProductAttempts':0,'oldMethodExecutions':0})
save('classification.json',{'newFormalFindings':[],'newCandidates':[],'newRelated':[],'counts':{'newFormal':0,'newCandidate':0,'newRelated':0},'kind':'Metadata coverage bookkeeping update, not bug discovery/fix status or new semantic source review','indexStatusCounts':s['after46to60ConservativeMigration'],'deferredWithinRecognizedStandardRows':0,'deferredOutsideSelectedSchemaScope':'Earlier MD-only, archived noncanonical claims and other schema classes were not reclassified. Unknown is not proof of unread or defect absence.','noNewUniqueCoverageClaim':True})
save('validation.json',{'checks':{'files':[]},'productSourceSemanticRead':0,'productImportsExecution':0,'productHelpersFixturesTestsRun':0,'modelClockNativeNetworkGit':0,'allowedSourceOperation':'Raw bytes, SHA256 and line-count inventory only on original4643 declared source paths plus one named evidence fixture.','metadataChecks':'Original base and all new rows/pointers/ranges/status transitions recomputed; no author/old normalizer method executed.','testDeclarationHandling':'11 of51 newly-classified-full paths are existing test declaration texts, not tests executed or passing; other full totals also retain original purposes.','wholeRepositoryConclusion':False})
report=f'''# prep154：正式46–60规范语义记录的保守覆盖迁移

已实际生成[更新统一索引](unified-current-index.json)和[逐路径transitions](transitions.json)。原4643路径分母保持不变，当前同SHA保守状态为 **355 full、354 selected、3934 unknown**。这是历史审查记录的元数据归类，**不是本轮新读源码，不是剩余未读文件数、剩余bug数或全机制正确性结论**。

| 同一4643路径口径 | full | selected | unknown |
|---|---:|---:|---:|
| 原55发布索引，逐路径复现 |304|168|4171|
| 当前SHA绑定后的原状态 |304|168|4171|
| 合并规范46–60明确语义记录 |355|354|3934|

237个状态变化全部来自unknown：51→full、186→selected；另外73个已知状态路径仅新增范围/provenance。619个标准primary rows中接受495行，归并为310个当前路径，**不相加作者/复核者文件数或阅读行数**。full必须有单份原记录明确full且语义范围覆盖当前EOF，不能由多份selected范围union自动升级。51个新增full中{testfull}个是既有测试声明全文，仍不代表运行/通过。每条原用途、平台/机制限制与声明边界保存在[accepted claims](accepted-claims.json)，51项代表原对象/pointer/SHA/EOF和用途复核见[new-full provenance](new-full-provenance.json)。

## 本次适配规则与真实排除

独立[标准库适配器](migrate-coverage.py)只处理formal46–60规范作者/Root/真实source reviewer manifest的 `.files`；不递归提取derived claims、历史old-full引用或source-excerpts。111份已预pin元数据中，77份非空标准列表实际处理；15份aggregate source字节绑定、17份空semantic gate、2份inactive first/并发旧快照明确跳过。空files的旧full gate不能凭引用算一次新阅读。后续副本、作者/复核者重叠只附原canonical provenance到同path/SHA，状态取可信最强分类。

唯一直接源hash字段allowlist是保留数字的归一化 `sha256`，归一化规则为lowercase alphanumeric（含0–9），支持read/ending别名仅作冲突检查；509个需绑定的行全部识别，非0/511。范围只接受明确整数对的selectedLineRanges，检查EOF、语义计数、已记录display+nav包含关系；hash/nav/body0/semantic0不升级。full veto、缺范围、条件/未知schema、冲突SHA或范围错误将拒绝/待核；没有制造假的元数据fixture来填满guard分支。

实际排124行：14个旧SHA、63个原分母外文件、47个明确hash/nav/instruction-only。14旧SHA包括旧MessageStream、types、TurnProcessGroupCard、compress和对应test版本；不能因后来某段字节可能相同就把旧整文件SHA当当前覆盖。详见[排除/文档决定](excluded-deferred.json)。本次77份已识别标准files schema内无未解决row/deferred document；这不意味着其它MD-only/旧archive/非规范schema已全部适配，仍保守留在旧状态。完整显示但无语义分类的aggregate行不被提升。

## 原0/511与自身首输出

旧55 normalizer的 `increment.first.py`、first summary/claims/index及诊断均保留原处不改、不执行；[原件pins](old-first-preservation-pins.json)、[其余first pins](old-first-extra-pins.json)结束仍同字节。原诊断明确它把sha256数字去掉成sha、allowlist却仍sha256，0/511不是有效无增量结论。本次只读取其结果/诊断元数据，未运行旧方法。

自身首个schema探测误查coverage/status字段打印None4643，只属探测，已保存[首探测](schema-probe-diagnostic.json)，实际迁移前按publishableCurrentCoverage逐路径复现正确304/168/4171。首次适配[stdout](migration-first.stdout)/[stderr](migration-first.stderr)/[exit](migration-first-exit.json)在查看前保存，exit0。首次宽展示7185tokens超4700预算，未见中段不算亲读；之后全部51full代表项已用两个完整有界窗口补读元数据。[诊断](metadata-presentation-diagnostics.json)原样保留这些限制。

第一版accepted结果另存[原first claims](accepted-claims.first.json)，后以[约束保留脚本](preserve-constraints.py)补原row/doc限制，无分类/计数变化；[记录](constraint-preservation.json)保留前后hash。独立[元数据检查器](verify-migration.py)未调用适配方法，重绑全部495原pointer/range/SHA，重建4643路径状态及237变化，见[verification](verification-checks.json)。这不是产品测试或第二份源码阅读。

## 当前字节绑定与交付边界

[当前4643库存](current-source-inventory.json)只读原路径源bytes/hash/行数，产品内容未作语义阅读，全部与原55索引SHA相同、0missing；[ending库存](ending-source-inventory.json)再次bulk核4643全部同SHA。额外旧57 `static-path.test.ts`仅hash且单列分母外，不把审查fixture混成新产品覆盖。source-manifest只[引用库存artifact本身](source-manifest.json)，不复制4643条product hash rows到其files/hashOnlySourceRows，Root可另做Git版本绑定。Root报告的HEAD `659b6b2ce5888723a40ce046cbbf643382cb130b`仅上下文，本人Git0。

[结束检查](ending-checks.json)119个原元数据/指令pin均无漂移，包括111份输入manifest与旧失败原件；结束时间不认证未来变化。[输入pin](initial-pins.json)、[111份manifest pin](manifest-inventory-pins.json)、[schema inventory](schema-inventory.json)、[迁移summary](migration-summary.json)、[分类](classification.json)、[验证边界](validation.json)与[自排除receipt](artifact-receipt.json)均保存。

本角色产品语义 `files=[]`；仅运行自有标准库元数据适配/核对与bulk字节hash脚本，产品import/helper/fixture/test/模型/权限/native/网络/Git0。full代表原有限目的下的完整语义文本记录，不认证整个行为、转接机制、平台或实时状态；unknown也不等于未读/尚未审完。仍不能给出全仓精确剩余审查量或剩余问题数。
'''
(O/'report.md').write_text(report);links=re.findall(r'\]\(([^)]+)\)',report);planned=['artifact-receipt.json'];assert all((O/x).is_file() for x in links if x not in planned)
save('freeze-checks.json',{'atUTC':at,'role':'Author metadata finalization only','checks':{'files':[]},'links':[{'target':x,'insideOwnedDir':(O/x).resolve().is_relative_to(O.resolve()),'existsOrPlannedSelfGenerated':(O/x).is_file() or x in planned} for x in links],'plannedSelfGenerated':planned,'baseCounts':{'full':304,'selected':168,'unknown':4171},'finalCounts':s['after46to60ConservativeMigration'],'denominator':4643,'productSourceSemanticRead':0,'oldMethodsExecuted':False,'git':0})
files=[]
for p in sorted(O.iterdir()):
 if p.is_file() and p.name!='artifact-receipt.json':
  b=p.read_bytes();files.append({'path':p.name,'bytes':len(b),'sha256':h(b)})
save('artifact-receipt.json',{'frozenUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'role':'Metadata-only conservative source coverage migration; not product source review','files':files})
assert all((O/x).is_file() and (O/x).resolve().is_relative_to(O.resolve()) for x in links)
for x in files:
 b=(O/x['path']).read_bytes();assert len(b)==x['bytes'] and h(b)==x['sha256']
print('ARTIFACTS',len(files)+1,'RECEIPTROWS',len(files),'LINKS',len(links),'NEW FULL TEST DECL',testfull)
for n in ['report.md','source-manifest.json','artifact-receipt.json']:
 b=(O/n).read_bytes();print(n,len(b),h(b))
