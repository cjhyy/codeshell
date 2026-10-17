from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round150-build-meta')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,d):(O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def load(n):return json.loads((O/n).read_text())
at=datetime.datetime.now(datetime.timezone.utc).isoformat();pins={}
for n in ['initial-pins.json','package-before-pins.json','config-before-pins.json']:
 for x in load(n)['files']:pins[x['path']]=x
textfiles={'scripts/build-meta.ts':38,'packages/core/tsconfig.json':22,'packages/tui/tsconfig.json':34}
ptrs={
 'package.json':['/name','/type','/version','/main','/types','/bin','/exports','/files','/workspaces','/dependencies','/scripts/build','/scripts/build:server','/scripts/test:package-release'],
 'packages/core/package.json':['/name','/type','/main','/types','/bin','/exports','/files','/scripts/build','/scripts/copy-assets','/scripts/clean'],
 'packages/tui/package.json':['/name','/type','/main','/types','/bin','/exports','/files','/scripts/build','/scripts/clean']
}
rows=[];excerpts=[];ends=[]
for p,x in pins.items():
 b=(R/p).read_bytes();hh=h(b);ends.append({'path':p,'initialBytes':x['bytes'],'initialSha256':x['sha256'],'finishBytes':len(b),'finishSha256':hh,'sameBytesAndSha256':len(b)==x['bytes'] and hh==x['sha256']})
 if p in textfiles:
  z=textfiles[p];rows.append({**x,'coverage':'full','selectedLineRanges':[[1,z]],'semanticLines':z,'displayedLineRanges':[[1,z]],'uniqueDisplayedLines':z,'purpose':'Ordinary declared paths/content/config, never executed. Build-meta full source is explicit same-SHA R24/R31 prior overlap; compiler/runtime/native correctness not certified.','sameShaOldFull':p=='scripts/build-meta.ts','newUniqueCoverageClaim':False,'finishSha256':hh,'finishMatchesInitial':hh==x['sha256']});excerpts.append({'path':p,'sha256':hh,'ranges':[{'start':1,'end':z,'lines':b.decode().splitlines()}],'captureTiming':'After actual complete source display, not runtime execution or new semantic read.'})
 elif p in ptrs:
  d=json.loads(b);vs=[]
  for ptr in ptrs[p]:
   v=d
   for k in ptr.strip('/').split('/'):v=v[k]
   vs.append({'pointer':ptr,'value':v})
  rows.append({**x,'coverage':'selected-json-values','selectedJsonPointers':ptrs[p],'selectedLineRanges':[],'semanticLines':None,'purpose':'Selected current package values for root meta build/exports/bin/files and core/TUI actual target declarations, not all package dependencies/platform support.','newUniqueCoverageClaim':False,'finishSha256':hh,'finishMatchesInitial':hh==x['sha256']});excerpts.append({'path':p,'sha256':hh,'objects':vs,'captureTiming':'After actual selected original JSON values displayed; byte hash not full JSON semantic reading.'})
entries=[{'path':p,'isFile':(R/p).is_file(),'contentRead':False} for p in ['packages/core/src/index.ts','packages/tui/src/cli/main.ts']]
save('declared-entry-inventory.json',{'atUTC':at,'filenames':entries,'scope':'Only declared source entry filenames; no CLI/module import or source body read, no dist/output or runtime export completeness proof.'})
save('source-manifest.json',{'atUTC':at,'rootReportedBaselineOnly':'c6a85ac1b69329f35bc1f6ff34d08070f91b1d96','role':'Independent directed ordinary meta build path/config contract source review; known old full overlap, no new unique coverage claim','files':rows,'instructionHashOnlyFiles':[pins['AGENTS.md'],pins['CODESHELL.md']],'instructions':'Prior actual AGENTS5/CODESHELL217 read carried under identical SHA, hash-only this task.','totals':{'semanticFiles':6,'fullTextFiles':3,'selectedJsonDocuments':3,'textSemanticLines':94,'selectedJsonPointers':sum(len(v) for v in ptrs.values()),'testDeclarationsRead':0,'instructionHashOnly':2,'sourceEntryFilenameOnly':2,'declaredResourceFilenameOnly':4,'newUniqueCoverageClaim':False},'limits':'Full script/config source reading is not execution, native/permissions/platform certification, compiler output observation or package tarball/import/release validation. JSON lines not falsely counted from selected-value formatting.'})
save('source-excerpts.json',{'files':excerpts,'productExecution':0})
canon=load('canonical-before-pins.json')['files'];nav=load('targeted-history-navigation.json')['files'];he=[]
for x in canon+nav:
 b=(R/x['path']).read_bytes();he.append({'path':x['path'],'initialSha256':x['sha256'],'finishSha256':h(b),'sameBytesAndSha256':len(b)==x['bytes'] and h(b)==x['sha256']})
bp=load('shared-history-projection.json')['sharedBatch'];bb=Path(bp['path']).read_bytes();resource=load('declared-resource-inventory.json');resourceEnding=[{'path':x['path'],'isFile':(R/x['path']).is_file(),'matchesInitialExistence':(R/x['path']).is_file()==x['isFile'],'contentRead':False} for x in resource['filenames']]
save('ending-checks.json',{'atUTC':at,'sourceAndInstructionPins':ends,'all8SourceAndInstructionPinsSame':all(x['sameBytesAndSha256'] for x in ends),'canonicalAndRawNavigationPins':he,'all5CanonicalAnd32NavigationPinsSame':all(x['sameBytesAndSha256'] for x in he),'sharedBatch':{**bp,'finishBytes':len(bb),'finishSha256':h(bb),'sameBytesAndSha256':len(bb)==bp['bytes'] and h(bb)==bp['sha256']},'declaredResourcesFilenameOnly':resourceEnding,'declaredEntriesFilenameOnly':entries,'limits':'No product binary contents/dist/build/real publish/Git verification; batch byte equality does not own-reverify every6126 member.'})
save('gate-decision.json',{'sameShaFullEvidence':[{'path':'docs/audit-2026-10-17-round24/evidence/root-package-prep/source-manifest.json','pointer':'/sources/131','exactCoverage':'full static, never executed','sha256':pins['scripts/build-meta.ts']['sha256']},{'path':'docs/audit-2026-10-17-round31/evidence/entry-source-manifest.json','pointer':'/files/11','exactCoverage':'full1–38, initial/finish matches, build-script-source-only','sha256':pins['scripts/build-meta.ts']['sha256']}],'selectedOnlyEarlierEvidence':{'path':'docs/audit-2026-10-17-round6/source-manifest.json','pointer':'/files/87','limits':'Hash equality plus selected inventory scope is not same-SHA full proof by itself.'},'canonicalReadWindows':[{'path':'docs/audit-2026-10-17-round6/root-package.md','ranges':[[1,26]]},{'path':'docs/audit-2026-10-17-round6/source-manifest.json','pointers':['/files/87','/note']},{'path':'docs/audit-2026-10-17-round24/evidence/root-package-prep/source-manifest.json','pointers':['/sources/131','/note']},{'path':'docs/audit-2026-10-17-round31/evidence/entry-source-manifest.json','pointers':['/files/11','/sourceFinishChecks/11'],'note':'Read matching original rows/scope fields only; no source-excerpts/old CLI fixture.'},{'path':'docs/audit-2026-10-17-round24/evidence/root-package-prep/package-summary.json','limits':'Parsed for matching path/object/scope fields; no substantive matching path row, no semantic full-summary claim.'}],'rootScopeSteering':'Retain original directed current root config→meta output contract; do not mechanically search a new leaf. Known full script reread is old overlap.','sharedCap':'6126 snapshot,109total matches, only first100 retained at cap100; no full matching-context semantic claim.','unknownIsUnread':False,'hashIsFullReading':False})
save('classification.json',{'formalFindings':[],'candidates':[],'newRelated':[],'counts':{'newFormal':0,'newCandidate':0,'newRelated':0},'boundedConclusion':'Current declared root entry/exports/bin/content/config paths align with inspected build meta output statements and target package export paths. No new ordinary mismatch established.','scopeExclusions':['Old A11 release push/tag branch cause not investigated/reported or tested; Root-assigned exclusion.','Root R6 test:watch candidate not reclassified or reopened.','No arbitrary missing dist, dirty build, illegal CLI arguments, unsupported cross-platform chmod/shell behavior or published-version rewrite assumption used as a bug.','Permanent failed dynamic directions remain skipped.']})
save('diagnostics.json',{'productAttempts':0,'productFailures':0,'navigationFailures':[],'metadataErrors':[],'truncations':[],'note':'All actual bounded source/canonical tool output for prep150 completed without observed nonzero/truncation. Shared match cap109/100 is explicitly separate from tool truncation. Waited for Root153 final batch signal before canonical/source body.'})
save('validation.json',{'productBuildInstallReleaseExecution':0,'helperImportsExecution':0,'testsOrFixturesRead':0,'testsRun':0,'realCliNativeNetworkGit':0,'generatedDistRead':False,'resourceBinaryRead':False,'oldTests':'Only old R6 report describes its existing tests and limits; no old logs/fixtures opened or pass borrowed as current validation.','metadataOnlyFinalization':{'checks.files':[],'method':'Python standard-library JSON/source-text/range/hash/link/receipt processing; no build/helper/import/compiler invoked.'}})
report='''# prep150：Root meta package 输出路径与声明合同

**有限0新正式问题、0候选、0new-related。** 亲读当前 root 配置、build-meta 声明输出及 core/TUI 目标包配置，未建立正常入口下的导出/bin/资源路径错位。未执行 build、import、helper、test、install、release、CLI、native、网络或Git。

Root提供冻结上下文 `c6a85ac1b69329f35bc1f6ff34d08070f91b1d96`；本人未读取Git。AGENTS/CODESHELL延用此前实际阅读并核同SHA。[初始pin](initial-pins.json)、[包pin](package-before-pins.json)、[config pin](config-before-pins.json)均在各自body/行号导航前。

## 当前普通链

- 根 `package.json#/scripts/build` 先列core/TUI等包的build，最后才运行 `scripts/build-meta.ts`；根依赖声明core和TUI workspace包。这里不推断安装/发布时workspace版本如何改写，也不保证build成功。
- 根 main、types、root exports 分别为 `dist/index.js` 与 `dist/index.d.ts`；build-meta26–27声明写同路径并 `export *` from core。core root exports也声明其 `dist/index.{js,d.ts}`。不是从当前dist存在性反推成功。
- 根bin指 `dist/cli.js`；script29–31声明带shebang的import `@cjhyy/code-shell-tui/cli`，TUI `exports./cli` 对应 `dist/cli/main.js`/声明文件。script35–38另声明旧 `dist/cli/main.js` launcher import `../cli.js`；保留旧链接合同而不保留过时bundle。正常参数、真实CLI控制没有运行。
- core/TUI scripts的正常构建入口是各自tsc配置。所读config声明 `rootDir=./src`、`outDir=./dist`、declaration与include规则；`src/index.ts`、`src/cli/main.ts`只核实际文件名存在。所列预期输出布局与exports一致，未读取/生成dist或验证编译器实际产物。
- meta脚本只声明清除/重建root dist和这些转发文件；root `/files`另显式列4个图像资源路径，它们目前文件名存在，见[资源库存](declared-resource-inventory.json)。没有读取二进制、渲染、打包tarball或完整资源依赖闭包；没有凭“脚本未copy根图像”推断资源丢失，因为这些资源是package files的直接声明。core/TUI copy-assets脚本值只作为当前build配置读到，不展开其它复制leaf。

## 旧范围与实际阅读

原R24 `root-package-prep/source-manifest#/sources/131`明确同SHA build-meta full static；R31 `entry-source-manifest#/files/11`也明确full1–38并保存before/finish。因此本轮38行全文为**旧全文重叠的定向配置合同复核**，不算新增唯一覆盖。R6 `/files/87`只有hash/selected inventory，本身不能作全文证明。当前任务保留上述实际传递链，没有为凑未读模块换leaf。详见[gate](gate-decision.json)与[canonical pins](canonical-before-pins.json)。

亲读旧R6 `root-package.md:1–26`仅核其原范围和测试边界。旧A11 release push/tag是范围排除，不重报；旧test:watch候选不作本批重新判定。旧报告17pass等为当时记录，没有打开/运行其fixture或日志，不能当本轮通过。

[源manifest](source-manifest.json)有6语义文件：3个全文文本文件合计94行（含旧build-meta38行）与3份selected JSON值文档，共32个原JSON pointers；JSON值格式化输出不伪算原文件逐行覆盖。另2指令hash、2入口和4资源仅文件名元数据。配置全文不等于编译器/native/权限或完整发布机制认证。[选段](source-excerpts.json)在实际显示后复制已读文本/原值，不执行。

## 历史、结束与收据

Root153[共享投影](shared-history-projection.json)为6126 MD/JSON、4322397递归JSON value scalars、0parse，含archive、排keys、纳冻59排60+。build-meta109命中，**cap100只保留前100**；不能把前100当全context审读。[原始path/SHA导航](targeted-history-navigation.json)另保留32份字节pin，仅用于定位原件，非第二次全历史semantic/cause扫描。

[首诊断](diagnostics.json)本轮无失败或tool截断；cap是检索保留限制而非tool错误。[结束核对](ending-checks.json)8个源/指令pins、5canonical+32原导航pins及共享batch全同字节；文件名存在性也保留。不据此认证全部6126成员、未来Git或真实发布包。[分类](classification.json)、[验证边界](validation.json)、[入口库存](declared-entry-inventory.json)、[冻结检查](freeze-checks.json)、[自排除receipt](reviewer-receipt.json)保留。
'''
(O/'report.md').write_text(report);links=re.findall(r'\]\(([^)]+)\)',report);planned=['freeze-checks.json','reviewer-receipt.json'];assert all((O/x).is_file() for x in links if x not in planned)
save('freeze-checks.json',{'role':'Author metadata finalization, not new source semantic or runtime validation','checks':{'files':[]},'textLineCount':94,'selectedJsonPointerCount':sum(len(v) for v in ptrs.values()),'links':[{'target':x,'insideOwnedDir':(O/x).resolve().is_relative_to(O.resolve()),'existsOrPlannedSelfGenerated':(O/x).is_file() or x in planned} for x in links],'plannedSelfGenerated':planned,'allSourcePinsSame':all(x['sameBytesAndSha256'] for x in ends),'allHistoryPinsSame':all(x['sameBytesAndSha256'] for x in he),'productExecution':0,'git':0})
files=[]
for p in sorted(O.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes();files.append({'path':p.name,'bytes':len(b),'sha256':h(b)})
save('reviewer-receipt.json',{'frozenUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'role':'Independent bounded current meta output contract source review, own metadata receipt only','files':files})
assert all((O/x).is_file() and (O/x).resolve().is_relative_to(O.resolve()) for x in links)
for x in files:
 b=(O/x['path']).read_bytes();assert len(b)==x['bytes'] and h(b)==x['sha256']
print('ARTIFACTS',len(files)+1,'ROWS',len(files),'LINKS',len(links),'JSONPOINTERS',sum(len(v) for v in ptrs.values()))
for n in ['report.md','source-manifest.json','reviewer-receipt.json']:
 b=(O/n).read_bytes();print(n,len(b),h(b))
