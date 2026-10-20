from pathlib import Path
import json,hashlib,subprocess,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
out=Path('/tmp/codeshell-audit-round25-link-frontier')
def write(name,value):
 (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def sha(raw):return hashlib.sha256(raw).hexdigest()
def head():return subprocess.run(['git','rev-parse','HEAD'],cwd=root,capture_output=True,text=True,check=True).stdout.strip()
def json_file(path):return json.loads((root/path).read_text())
frozen='c9056c8047a8e75ab2469e59bf1d3fedd9ad7272'
read_head=json_file('/tmp/codeshell-audit-round25-link-frontier/inventory.json')['readHead']
scopes=[
 ('CODESHELL.md','full',None,'Repository instructions; parent owns branch/worktree integration; no Git writes.'),
 ('packages/link/README.md','full',None,'Portable manifest/public package contract; upstream statements are not revalidated.'),
 ('packages/link/package.json','full',None,'Actual public entry metadata only; no dist/build/package runtime validation.'),
 ('packages/host/README.md','full',None,'Public synchronous lifecycle contract; credential paragraphs read as context, not validated.'),
 ('packages/host/package.json','full',None,'Actual public entry/dependency metadata only.'),
 ('packages/link/src/catalog.ts','full',None,'705 lines read in bounded contiguous segments; pure metadata, lookup and typed localization. No auth/permission/provider URL validation.'),
 ('packages/link/src/types.ts','full',None,'Portable presentation data shapes; no runtime imports.'),
 ('packages/link/src/recipes.ts','full',None,'Read-only metadata compatibility projection; no record/store/access execution.'),
 ('packages/link/src/figma.ts','full',None,'Local string constants, reviewed action-id membership; no upstream API or OAuth claims verified.'),
 ('packages/link/src/index.ts','full',None,'Public exports/import-edge inventory only; never imported.'),
 ('packages/link/src/catalog.test.ts','full',None,'Existing source test declarations/contract counterevidence only; not executed.'),
 ('packages/link/src/recipes.test.ts','full',None,'Existing ordinary schema/projection declarations/contract counterevidence only; not executed.'),
 ('packages/link/src/operation-types.ts','selected',[[69,118]],'Recipe union/data shape plus adjacent request/error declarations; no authorization validation.'),
 ('packages/host/src/runtime.ts','full',None,'117-line ordinary synchronous registry/lifecycle; no construction, callbacks or dispatch.'),
 ('packages/host/src/index.ts','full',None,'13-line public export inventory; host-request authority implementation not re-read.'),
 ('packages/server/src/links/catalog.ts','full',None,'57-line actual pure compose function and impure default-registration entry boundary, static only.'),
 ('packages/desktop/src/main/link-provider-catalog.ts','full',None,'6-line compatibility re-export; no server barrel imported.'),
 ('packages/desktop/src/main/link-provider-catalog.test.ts','full',None,'25-line existing two-test declaration; trusted executor fixture not executed.'),
 ('packages/server/src/links/service.ts','selected',[[235,265]],'Ordinary createLinkService takes catalog at line243; nearby constructor/state context only; not a full service/auth audit.'),
 ('packages/desktop/src/main/index.ts','selected',[[4206,4213]],'Ordinary links:listLocalProviders IPC registration at4210; neighboring lines incidental; no Electron import/execution.'),
 ('docs/todo/link-catalog-compatibility-delivery.md','full',None,'Existing cross-version discovery contract and previously reported validations; no historical raw receipt retrieval or rerun.'),
 ('docs/todo/link-connector-refactor-delivery-2026-10-16.md','full',None,'Five-recipe/schema2 compatibility contract and previously reported verification, not current execution.'),
 ('docs/todo/link-connector-refactor-plan-2026-10-16.md','selected',[[87,125]],'Explicit current-host versus device recipe mapping and model boundary; larger initial read was output-truncated and is not claimed full.'),
 ('docs/architecture/local-link-mvp.md','selected',[[39,72]],'Actual catalog/display/IPC design context; not current upstream-provider fact verification.'),
]
manifest=[]
for path,scope,ranges,note in scopes:
 raw=(root/path).read_bytes()
 frozen_blob=subprocess.run(['git','show',f'{frozen}:{path}'],cwd=root,capture_output=True,check=True).stdout
 head_blob=subprocess.run(['git','show',f'{read_head}:{path}'],cwd=root,capture_output=True,check=True).stdout
 manifest.append({'path':path,'lines':len(raw.splitlines()),'bytes':len(raw),'currentSha256':sha(raw),'frozenReferenceSha256':sha(frozen_blob),'readHeadSha256':sha(head_blob),'matchesFrozenReference':raw==frozen_blob,'matchesReadHead':raw==head_blob,'readScope':scope,'selectedLineRanges':ranges,'note':note})
write('source-manifest.json',{'readHead':read_head,'frozenReference':frozen,'frozenReferenceMeaning':'Existing round24 frozen source reference, not a claimed round25 branch or runtime freeze.','sources':manifest,'sourcePinCount':len(manifest),'full':sum(x['readScope']=='full' for x in manifest),'selected':sum(x['readScope']=='selected' for x in manifest),'notSemanticCoverage':'Full-file byte pins prove byte identity only; inventory-only and navigation-only files have not become full source coverage.'})
selected=[]
def parent(path,loc,value,note):
 raw=(root/path).read_bytes();selected.append({'path':path,'sha256':sha(raw),'parent':loc,'value':value,'interpretation':note})
p='docs/audit-2026-10-17-round3/evidence/host-receipts.json';j=json_file(p)
parent(p,'$.runs / $.total / $.findings / $.boundaryOnly / $.unconfirmedCandidates',{k:j[k] for k in ['runs','total','findings','boundaryOnly','unconfirmedCandidates']},'Actual bounded receipt parents read; historical26 pass/323expect includes selection, baseline and ordinary operation cases, not this proposal execution. No raw or provider/native assertions independently rerun.')
p='docs/audit-2026-10-17-round3/evidence/host-source-manifest.json';j=json_file(p)
arr=[e for e in j['sources'] if e['path'].startswith(('packages/link/','packages/host/'))]
parent(p,'$.sources[entries with actual packages/link or packages/host paths]',[{**e,'currentSha256':sha((root/e['path']).read_bytes()),'currentMatchesPrior':e['sha256']==sha((root/e['path']).read_bytes())} for e in arr],'Actual source records, not initial inventory hits. Scope limits come from the full host-link.md report; unchanged hashes are not proof of no bugs.')
p='docs/audit-2026-10-17-round11/evidence/host-validation.json';parent(p,'$',json_file(p),'Full validation parent read:6 pure synchronous controls/22expect, no new findings or candidates; not current tests.')
p='docs/audit-2026-10-17-round11/evidence/host-lifecycle-controls.first.receipt.json';parent(p,'$',json_file(p),'Full first-run metadata read; current proposal did not retrieve or execute that runtime.')
p='docs/audit-2026-10-17-round11/evidence/host-source-manifest.json';j=json_file(p)
parent(p,'$.files[entries with actual packages/host paths]',[e for e in j['files'] if e['path'].startswith('packages/host/')],'Actual full/selected prior scopes read, including declaration that mixed request/approval existing suite was not run.')
p='docs/audit-2026-10-17-round23/evidence/root-source-manifest.json';parent(p,'$.files[9]',json_file(p)['files'][9],'Recipes prior coverage is full exploratory static only, not dynamic success.')
p='docs/review-2026-10-12/validation/postdelivery-report-review/audit-c.raw.json';parent(p,'$.module_coverage[4]',json_file(p)['module_coverage'][4],'Earlier Links upper-layer coverage explicitly was not independent full manifest/catalog review; not inflated into full coverage. Later round3 report considered separately.')
p='docs/review-2026-10-12/validation/desktop-main-results.json';parent(p,'$[101]',json_file(p)[101],'Historical code0 row alone is not complete runtime evidence.')
p='docs/review-2026-10-12/validation/original-baseline-evidence-round28/independent-existing-tests.receipt.json';parent(p,'$.groups[2].rawLogs[101]',json_file(p)['groups'][2]['rawLogs'][101],'Bounded parent reports2pass/0fail complete marker and raw hash; not accessed under historical /private/tmp and not this proposal execution.')
p='docs/review-2026-10-12/validation/original-baseline-evidence-round28/manifest.json';parent(p,'$.logs[524]',json_file(p)['logs'][524],'Matching historical2-test archive metadata; no archive extraction or product execution.')
md=[]
for p in ['docs/audit-2026-10-17-round3/host-link.md','docs/audit-2026-10-17-round11/host.md']:
 raw=(root/p).read_bytes();md.append({'path':p,'sha256':sha(raw),'readScope':'full','lines':len(raw.splitlines()),'text':raw.decode()})
write('history-selected.json',{'records':selected,'fullReadReports':md,'limits':'Bounded primary parents and reports were read. Navigation hits alone are not evidence of coverage. Historic raw log paths are provenance strings only, not opened here.'})
patterns=['localizeLinkText|getLinkProviderManifest|LINK_PROVIDER_MANIFESTS','linkConnectionMetadata|resolveLinkRecipeId|getLinkConnectionRecipe','composeLinkProviderCatalog|listDesktopLinkProviders']
nav=[]
for pattern in patterns:
 result=subprocess.run(['rg','-n',pattern,'packages','--glob','*.ts','--glob','*.tsx'],cwd=root,capture_output=True,text=True,check=True)
 nav.append({'pattern':pattern,'scope':'packages/**/*.ts and **/*.tsx','exitCode':result.returncode,'lines':result.stdout.splitlines(),'reading':'Navigation only; grep lines do not assert full consumer review.'})
write('caller-navigation.json',{'readHead':read_head,'queries':nav,'keyBoundary':'Catalog/index consumers were selected-read as listed in source-manifest. Recipe access/routing consumers were navigation-only and excluded from authority validation.'})
write('metadata-notes.json',{'allWritesUnder':str(out),'productAttempts':0,'tests':0,'imports':0,'fixtures':0,'vm':0,'network':0,'browser':0,'native':0,'realAuthPermissionCustodyIdentitySecurityExecution':0,'gitWrites':0,'currentRound24Writes':0,'metadataOnly':['rg inventories/navigation','Python standard-library text/JSON/hash collectors','Git rev-parse/branch/show read-only metadata'],'outputTruncation':[{'operation':'A combined static read of plan1-125 and other source exceeded tool aggregate output budget.','resolution':'No full-plan reading claim. Contract selected87-125 and local-link selected39-72 independently re-read within bounded output. All source target sections used for conclusions are separately complete.','productFailure':False}],'priorExcludedDirections':['No package dist absence/resolver export failure retry','No Unicode/slice/file-selection repeat','No actual auth/provider/permission/custody/identity/security/native/process/CLI/network validation','No known failed/skipped direction reopened'],'sourceChanges':'No source or old audit edits by this subagent.'})
history=json.loads((out/'history.json').read_text())
proposal={
 'status':'negative-frontier-proposal',
 'summary':'No new independent ordinary-input bug or dynamic lane established in the selected Link/Host manifest/configuration/display scope. Do not schedule a baseline rerun merely because these leaves are easy to execute.',
 'readHead':read_head,'completionHead':head(),'existingFrozenReference':frozen,'newRound25BranchCreated':False,
 'counts':{'formal':0,'candidate':0,'relatedNew':0,'productRuns':0,'testRuns':0,'imports':0,'fixtures':0,'vm':0,'network':0,'gitWrites':0},
 'inventory':{'file':'inventory.json','actualLinkHostPaths':27,'allBytesMatchFrozenReference':True,'note':'Full bytes hashed for inventory; only source-manifest readScope is semantic reading.'},
 'sourceManifest':'source-manifest.json',
 'dedup':{'corpus':'history.json','supplementalProjectionSearch':'projection-history.json','boundedPrimaryParents':'history-selected.json','totals':history['totals'],'round24Partition':history['round24Partition'],'allArchivesIncluded':True,'excluded':[],'exactPureLeafMatches':31,'manifestConfigurationMatches':675,'hostRegistryMatches':142,'projectionMatches':15,'contextCap':100,'note':'All current docs/bugs MD and recursive JSON scalar values searched, including archive/_archive. Round24 included but separately partitioned; it does not prove current product execution. Capped keyword contexts are navigation only; full human semantic exhaustion is not claimed.'},
 'ordinaryContractsAndCounterevidence':[
  {'source':'packages/link/src/catalog.ts:699-705','normalInput':'Known provider ID or an unknown ID; typed locale zh/en and bilingual text.','contract':'Provider lookup may return undefined; localizeLinkText indexes the two declared fields.','counterevidence':'Complete literal navigation found no localizeLinkText production call inside packages beyond declaration/export. No normal producer emitting an unsupported locale was found; inventing an invalid locale or caller mutation would not establish a bug. External SDK consumers were not audited.'},
  {'source':'packages/link/src/catalog.ts:1-705 and packages/link/src/types.ts','normalInput':'Current ten portable provider manifests, displayed through validated host catalog.','contract':'Presentation metadata does not execute commands or encode OAuth client configuration; coming-soon server methods are explicit.','counterevidence':'No local manifest schema, lookup or ordinary display contradiction established. Upstream permission/URL/CLI facts were not independently verified and are not findings. Mutable array/reference APIs lack an immutable snapshot contract; arbitrary caller mutation is not a demonstrated producer.'},
  {'source':'packages/link/src/recipes.ts:47-122','normalInput':'Five reviewed recipe IDs with schema2; legacy metadata compatibility.','contract':'New records persist recipe and derive axes; legacy incomplete records remain incomplete; future schemas/unknown recipe do not inherit legacy routes.','counterevidence':'Existing recipes.test.ts explicitly declares these boundaries, and round3 plus round23 already read this unchanged projection. Runtime is relative to current host in design, so local does not by itself mean an operator device. Real callers are credential/access/operation routes; no auth path executed or claimed.'},
  {'source':'packages/host/src/runtime.ts:1-117','normalInput':'Synchronous service registration/start/stop and capability lookup.','contract':'README declares synchronous lifecycle.','counterevidence':'Round3 and round11 actual parents cover ordinary lifecycle; prior HL-C1 mutable service-reference idea still lacks a demonstrated normal mutating producer or immutable snapshot contract. No new callbacks, dispatch, malformed inputs, async adapters or authority experiments.'},
  {'source':'packages/server/src/links/catalog.ts:17-56','normalInput':'Current manifest IDs/actions paired with corresponding trusted executor summaries; called at service.ts243 and Desktop IPC index.ts4210.','contract':'Provider/action sets must agree; duplicate/mismatch throws before catalog display.','counterevidence':'Static guards cover equal sets and both duplicate lists. Historical bounded receipt parents report the existing two-test baseline; no ordinary producer mismatch or new output problem established. Importing this module would load provider registration/Core edges, so it is not a safe standalone leaf import.'}
 ],
 'knownPriorExcluded':[
  {'id':'HL-01','scope':'Exact GitHub path whitespace trimming; unchanged file-selection.ts; not re-read or run as a new direction.'},
  {'id':'HL-02','scope':'Default-label UTF-16 slice; unchanged file-selection.ts; excluded Unicode/slice mechanism.'},
  {'id':'HL-C1','scope':'Caller-owned Host service mutation; old unconfirmed candidate, not promoted.'},
  {'id':'HL-B1/HL-B2','scope':'Encoded path and explicitly unavailable provider file content/synchronous Host boundaries; no new count.'},
  {'scope':'Historic upper-layer Link auth/recovery and catalog negotiation verification is provenance only; no credential/provider/security execution or repeat.'}
 ],
 'selectedNextDynamicDirection':None,
 'safeFutureStaticLeaves':[
  {'paths':['packages/link/src/catalog.ts','packages/link/src/types.ts','packages/link/src/figma.ts'],'runtimeImports':'catalog -> figma only; types type-only; figma has no imports. Public index also exports validation/operation/file-selection modules, so no barrel import was attempted.','possibleFocus':'Only a new normal caller/producer contract around localized fields, provider IDs or display metadata would justify reopening this static lane. Current source and tests provide no such bug trigger.','fixtureBoundaryIfSeparatelyAuthorizedLater':'A direct catalog leaf would need only owned plain bilingual DTOs and known provider IDs; no CLI, OAuth/provider fact validation, command execution, package barrel or malformed locale. No fixture authored or executed and no rerun recommended now.'},
  {'paths':['packages/link/src/recipes.ts'],'runtimeImports':'Only type import from operation-types.ts; no runtime dependencies.','possibleFocus':'A new normal schema2 producer/compatibility contract with inconsistent serialized metadata, if actual source evidence appears; do not mirror the current five-map implementation as a new bug test.','fixtureBoundaryIfSeparatelyAuthorizedLater':'Owned plain metadata only, direct pure leaf; exclude CredentialStore, LinkService, access/authority, OAuth, native and network. No fixture authored or executed; current lane not selected.'}
 ],
 'knownLimits':['No runtime validation or imported product code.','No upstream provider or operating-system facts verified.','Only bounded listed consumer sections read; recipe credential-routing consumers are navigation-only.','No full repository correctness or all-provider behavior claim.','All materials outside the repository; current round24 and earlier /tmp proposals preserved.'],
 'artifacts':['proposal.json','inventory.json','source-manifest.json','history.json','projection-history.json','history-selected.json','caller-navigation.json','metadata-notes.json','dedup.py','collect-proposal.py','artifact-receipt.json']
}
write('proposal.json',proposal)
files=[]
for p in sorted(out.iterdir()):
 if p.is_file() and p.name!='artifact-receipt.json':
  raw=p.read_bytes();files.append({'path':p.name,'bytes':len(raw),'sha256':sha(raw)})
write('artifact-receipt.json',{'selfExcluded':True,'completionHead':head(),'files':files,'total':len(files),'productAndTestRuns':0,'gitWrites':0,'note':'Author metadata receipt. No current raw runtime artifacts exist because no product/test/import/fixture attempts were made.'})
print(json.dumps({'proposal':str(out/'proposal.json'),'proposalSha256':sha((out/'proposal.json').read_bytes()),'sourcePins':len(manifest),'fullRead':sum(x['readScope']=='full' for x in manifest),'selectedRead':sum(x['readScope']=='selected' for x in manifest),'sourceBytesMatchFrozenAndReadHead':all(x['matchesFrozenReference'] and x['matchesReadHead'] for x in manifest),'authorArtifactsExcludingSelf':len(files),'readHead':read_head,'completionHead':proposal['completionHead']},ensure_ascii=False))
