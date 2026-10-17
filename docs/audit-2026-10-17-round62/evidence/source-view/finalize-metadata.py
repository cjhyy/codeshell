from pathlib import Path
import datetime
import hashlib
import json
import re

REPO=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round165-source-view')
NOW=datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(b):
    return hashlib.sha256(b).hexdigest()

def save(name,value):
    (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')

def nums(rs):
    return {n for a,b in rs for n in range(a,b+1)}

def spans(ns):
    result=[]
    for n in sorted(set(ns)):
        if result and result[-1][1]+1==n:
            result[-1][1]=n
        else:
            result.append([n,n])
    return result

initial=json.loads((OUT/'initial-pins.json').read_text())
pins=initial['files']+json.loads((OUT/'chain-pins.json').read_text())
prefix='packages/core/src/sources/'
link=prefix+'link-view.ts'
collection=prefix+'collection.ts'
catalog=prefix+'catalog.ts'
local=prefix+'collection-local.ts'
adapter=prefix+'adapters/collection.ts'
context=prefix+'context-summary.ts'
resolve=prefix+'resolve.ts'
body={link:[[1,97]],collection:[[1,89]],catalog:[[19,43],[165,176]],local:[[122,153]],adapter:[[40,49],[70,84],[116,147]]}
selected={link:[[12,36]],collection:[[1,89]],catalog:[[19,43],[165,176]],local:[[122,127],[129,130],[136,150]],adapter:[[43,44],[48,48],[70,83],[116,147]]}
nav_files={catalog:['catalog-navigation.first.stdout'],local:['local-navigation.first.stdout'],adapter:['adapter-navigation.first.stdout']}
rows=[]
for pin in pins:
    p=pin['path'];b=(REPO/p).read_bytes();assert sha(b)==pin['sha256'],p
    row=dict(pin)
    row['selectedLineRanges']=selected.get(p,[])
    row['semanticLineCount']=len(nums(row['selectedLineRanges']))
    row['bodyDisplayedLineRanges']=body.get(p,[])
    row['bodyDisplayedLineCount']=len(nums(row['bodyDisplayedLineRanges']))
    nav=[]
    for f in nav_files.get(p,[]):
        nav.extend(int(m.group(1)) for m in re.finditer(r'^(\d+):',(OUT/f).read_text(),re.M))
    row['additionalNavigationSnippetLineRanges']=spans(set(nav)-nums(row['bodyDisplayedLineRanges']))
    row['displayedLineRanges']=spans(nums(row['bodyDisplayedLineRanges'])|set(nav))
    row['displayedLineCount']=len(nums(row['displayedLineRanges']))
    row['semanticFull']=p==collection
    row['coverage']='full' if p==collection else ('selected' if p in selected else 'hash-only')
    row['category']='product-semantic' if p in selected else ('instruction-hash-reuse' if p in ('CODESHELL.md','AGENTS.md') else ('old-scope-body-before-excluded' if p in (context,resolve) else 'unused-test-hash-only'))
    row['scopeBoundary']='Ordinary source config/entry ID/name/display projection only. Filesystem, URL/Link I/O, account, grant, authority/credential and native mechanisms not certified. Earlier source reading overlap is retained; not first-ever or unique global coverage.' if p in selected else 'No own product body/navigation in prep165; hash alone is not semantic coverage.'
    if p==link:
        row['scopeBoundary']='Whole file displayed; only12–36 config→scopeId/title is semantic. Availability/credential/authority methods39–97 are displayed boundary only, with no auth/custody or safety certification.'
    if p==collection:
        row['scopeBoundary']='Full static DTO/schema leaf read. Normalizer and real path/identity/I/O enforcement callees not read or exercised; full file is not transitive mechanism certification. Prior original Sources MD7 already described selected reading, so no first-read claim.'
    rows.append(row)
product=[r for r in rows if r['category']=='product-semantic']
summary={'sourceRows':len(rows),'semanticProductRows':len(product),'semanticProductLines':sum(r['semanticLineCount'] for r in product),'fullStaticDtoLeafRows':1,'otherSelectedProductRows':4,'bodyDisplayLines':sum(r['bodyDisplayedLineCount'] for r in rows),'displayUnionLinesIncludingNavigation':sum(r['displayedLineCount'] for r in rows),'oldScopeBodyBeforeExcludedRows':2,'unusedTestHashOnlyRows':4,'instructionHashOnlyRows':2,'testDeclarationLines':0,'testExecution':0}
save('source-manifest.json',{'atUTC':NOW,'rootReportedBaseline':initial['rootReportedBaseline'],'gitCertified':False,'files':rows,'summary':summary})

save('gate-and-old-cause.json',{'sharedHistoryProjection':'history-projection.json','scope':'Prior history navigation only; all four target totals exceed100 and only first100 retained each. No absence/unread/novelty claim from capped navigation. MD/JSON original scopes personally read are listed here.','canonicalJsonRead':'canonical-read.json','originalMdReads':[{'path':'docs/audit-2026-10-17-round15/documents.md','lineRanges':[[1,27]],'meaning':'Line23 lists complete reading and resolve ordinary propagation; line25 states priority/summary chain. Old preflight/navigation/parse failure and SKIP boundaries are historical only, not resumed or borrowed.'},{'path':'docs/audit-2026-10-17-round20/coverage.md','lineRanges':[[1,15]],'meaning':'Original scope/testing limits only; no old pass becomes a prep165 product result.'},{'path':'docs/audit-2026-10-17/sources.md','lineRanges':[[1,74]],'semanticOldCauseRanges':[[46,56]],'meaning':'Original S03 is single-file query JSON.stringify followed by free-text scrubSecrets damaging serialization. The wrapper/source caller family is retained as old context, not newly counted or revalidated.'}],'exclusions':[{'path':context,'sha256':'adb53dc4fe6fa3d417f0893c64416447afdbc3305639aa3d27b29d229b203742','basis':'R20 root-source-manifest /files/11 explicit Full static leaf and same SHA36, also R15 same SHA + original scope MD; body0 now.'},{'path':resolve,'sha256':'3d54fa881dd97c8b183fef070dc4f69742b391a730f0f9f3b20bb47301a3ef98','basis':'R15 worker /files/7 same SHA138 combined with original documents.md23–25 complete/ordinary-propagation scope; same ordinary boundary excluded before body. Not a claim that all authority/custody contracts were historically reviewed.'}],'selectedLeafHistory':[{'path':link,'basis':'R44 claims5745–5747 original objects are inventory/pin/loaded-module/import metadata; no semantic-full scope in inspected rows. Not evidence of unread. Old loaded-module/native failure records were not opened or treated as execution/coverage.'},{'path':collection,'basis':'R44 claims5660–5662 same kind of inventory/pin/import metadata. Original sources.md7 says selected/逐段 reading, so this actual static DTO reread has known overlap, not first coverage.'}],'earlyS03Lookup':{'path':'docs/audit-2026-10-16/findings.json','query':'Exact issues[*].id == S03','retainedRows':0,'meaning':'Wrong historical epoch/limited locator, not an error or proof of no old cause. Filename-only S03 lookup found the actual original Sources report.'},'globalCoverageUpdated':False})

save('classification.json',{'counts':{'formal':0,'candidates':0,'newRelated':0},'formal':[],'candidates':[],'newRelated':[],'oldCauseReferences':[{'id':'S03','canonical':'docs/audit-2026-10-17/sources.md:46-56','countedAsNewRelated':False,'meaning':'Known serialization/redaction order cause; current adapter JSON.stringify branch alone is not evidence of a new bug or current outer scrubber fix status.'}],'negative':'No new ordinary source-reference/display/config counterexample established in the selected finite chain. Not all Sources/collections/URLs/authority or full IO review.','normalChainAndCounterevidence':['Catalog parse/save selected code validates Link/collection configs via their actual helpers; no invented malformed/null DTO supplied.','linkSourceView normal config schema/default params/size bound and scopeId/title projection were read; provider registry/action/availability/grant enforcement not audited.','Collection DTO declares bounded explicit entries with unique IDs and stable names; local capture uses the same schema for id/name/output, with actual IO/custody boundary excluded from correctness opinion.','Adapter uses the same entry.id for scope/resource lookup, relativePath??name for labels, and preserved entry.id/sourceHash in query/chunk references. No new mismatch found, no real file or query executed.','Context summary/resolve old-scope bodies excluded; no permanent parser/SDK/native/search failure direction reopened.']})

save('diagnostics.json',{'productHelperImportFixtureTestExecution':0,'gitCommands':0,'actualUserDataOrConfigurationRead':0,'networkNativeExecution':0,'firstInventoryExit':0,'metadataFailure':None,'outputTruncation':False,'initialInventoryExtra':'Filename glob also found adapters/collection.ts and four tests; adapter later selected under its initial before pin, tests stayed unused hash-only with declaration/body/execution0.','oldS03Lookup':'Original Oct16 findings exact id lookup retained0; normal metadata navigation corrected to original Oct17 Sources MD, with no product retry.','capLimitation':'Retained first100/110 link-view,100/593 context-summary,100/102 collection,100/132 resolve; no full-history semantic read or exhaustive absent cause conclusion.','sourceReadingEnded':NOW,'validation':'Own stdlib metadata range/hash/receipt only; no source helper, URL/Buffer/JSON/Intl fixture, historical author method, test or runtime executed.'})

metadata_pins=json.loads((OUT/'canonical-pins.json').read_text())+json.loads((OUT/'canonical-md-pins.json').read_text())+[json.loads((OUT/'old-s03-pin.json').read_text()),json.loads((OUT/'old-sources-md-pin.json').read_text())]
metadata_pins.append(json.loads((OUT/'history-projection.json').read_text())['sharedBatch'])
ending=[]
for pin in pins+metadata_pins:
    path=Path(pin['path']) if Path(pin['path']).is_absolute() else REPO/pin['path']
    b=path.read_bytes();ending.append({'path':pin['path'],'beforeSha256':pin['sha256'],'endingSha256':sha(b),'endingBytes':len(b),'unchanged':sha(b)==pin['sha256']})
assert all(r['unchanged'] for r in ending)
save('ending-checks.json',{'atUTC':NOW,'files':ending,'sourceInstructionChecks':len(pins),'boundedCanonicalSharedMetadataChecks':len(metadata_pins),'allUnchanged':True,'gitOrFrozenBlobVerification':False,'scope':'Only own pins and actual bounded metadata inputs; not a new scan or ending rehash of all6484 historical files.'})

report=f'''# Sources 引用与展示：有限静态审查

新增 **0 formal /0 candidate /0 related**。Root给定基线`{initial['rootReportedBaseline']}`，本代理Git0，未改产品。普通范围收在`linkSourceView`配置投影、collection显式manifest及最小catalog/capture/adapter字段链，不认证账号、权限、native或真实IO。

先核旧原件：context-summary R20 `/files/11` 明文Full static leaf、同SHA36；resolve R15 `/files/7`同SHA138，与documents.md23–25的完整/普通传播范围联合，二者此次body0排除。link-view/collection在所核R44对象只有inventory/hash/import/loaded-module记录，不把unknown称未读；原Sources MD7也说明collection曾逐段读取，本次重叠保留，不称首次。共享批次6484 MD/JSON、4639853递归value scalars，纳冻61排62+含archive，errors[]；四target分别110/593/102/132命中，各仅保留前100，不能当完整人工查重或无旧因证明。

实际两叶：link-view全文显示97行，但semantic只12–36的provider/action/params→scopeId/title；39–97可用性/credential/authority方法止于显示边界。collection1–89完整静态DTO/schema阅读：显式bounded entries、稳定ID/name/revision、唯一ID和字段限制。catalog19–43/165–176消费并校验两种配置；capture122–153按同schema验证普通id/name并产出entry；adapter按同entry.id查scope/resource，label使用relativePath??name，query/chunk保留entry.id/sourceHash。未建立新的正常数据不吻合，不用伪造null/坏路径/不存在provider造候选。URL规范化callee、真实读取/identity/custody、完整UI调用链未展开。

旧S03原sources.md46–56已亲读，是“JSON.stringify后free-text scrubSecrets损坏单文件JSON”。本次看见的adapter序列化分支是旧链重叠，未再计项，也不从局部代码判断当前外层脱敏是否已修。旧R15 parser/preflight/SDK/native及其他失败动态方向不恢复；旧27tests等只作历史文本，不借作本次pass。

[manifest](source-manifest.json)：5产品semantic rows共{summary['semanticProductLines']}行（collection1全文DTO leaf、其余4 selected）；body显示{summary['bodyDisplayLines']}、含导航逐文件union {summary['displayUnionLinesIncludingNavigation']}。旧范围排除hash-only2、未用test hash-only4、指令hash-only2；test声明/执行0。产品/helper/import/fixture/test/真实数据/网络/native/Git执行0，首元数据失败/截断均无。[旧范围与cause](gate-and-old-cause.json)、[history投影](history-projection.json)、[分类](classification.json)、[诊断](diagnostics.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。{len(pins)}源/指令与{len(metadata_pins)}有限canonical/shared输入结束SHA均同，非全历史复扫或全Sources无bug结论。
'''
(OUT/'report.md').write_text(report)
save('artifact-receipt.json',{'atUTC':NOW,'selfExcluded':'artifact-receipt.json','files':[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='artifact-receipt.json'],'productExecution':0,'gitCommands':0,'note':'Own metadata-only finalization; no product/helper/test/foreign method execution.'})
print(json.dumps({'summary':summary,'packetFiles':len(list(OUT.iterdir())),'endingChecks':len(ending)},ensure_ascii=False))
for n in ('report.md','source-manifest.json','artifact-receipt.json'):
    b=(OUT/n).read_bytes();print(n,len(b),sha(b))
