"""Freeze Root's finite static decision. No product execution."""
from pathlib import Path
import json, hashlib, datetime

ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round159-dotted-mcp-decision')
def sha(b): return hashlib.sha256(b).hexdigest()
def write(name,v): (OUT/name).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def union(ranges):
    seen=set()
    for a,z in ranges: seen.update(range(a,z+1))
    result=[]
    for n in sorted(seen):
        if result and n==result[-1][1]+1: result[-1][1]=n
        else: result.append([n,n])
    return result

pins={r['path']:r for name in ['initial-pins.json','bridge-before-pins.json'] for r in json.loads((OUT/name).read_text())['files']}
display={}
for n in range(1,5):
    for p,ranges in json.loads((OUT/f'source-read-0{n}-ranges.json').read_text()): display.setdefault(p,[]).extend(ranges)
semantic={
 'packages/core/src/capability-control/service.ts':[[107,109],[151,165],[174,179]],
 'packages/core/src/capability-control/overlay.ts':[[48,64],[184,211]],
 'packages/core/src/capability-control/project.ts':[[57,81]],
 'packages/core/src/settings/manager.ts':[[83,91],[144,155],[338,445],[501,502],[572,584],[701,709],[721,740],[872,890],[1109,1139]],
 'packages/core/src/settings/schema.ts':[[57,78],[345,380],[729,730]],
 'packages/desktop/src/renderer/settings/McpSection.tsx':[[444,453],[1319,1337],[1375,1375],[1394,1394]],
 'packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx':[[261,279]],
 'packages/desktop/src/preload/index.ts':[[1119,1123]],
 'packages/desktop/src/main/capabilities-service.ts':[[51,71],[114,120]],
 'packages/desktop/src/main/index.ts':[[3840,3847]],
 'docs/archive/bug-followups-2026-08-13.md':[[1,7],[36,45]],
}
files=[]; historical=[]; nav=[]
for p,r in pins.items():
    raw=(ROOT/p).read_bytes(); assert len(raw)==r['bytes'] and sha(raw)==r['sha256']
    row=dict(r,endingSha256=sha(raw),coverage='selected' if p in semantic else 'navigation-only',selectedLineRanges=union(semantic.get(p,[])),bodyDisplayedLineRanges=union(display.get(p,[])),newUniqueCoverageClaim=False,semanticFull=False)
    row['semanticLineCount']=sum(z-a+1 for a,z in row['selectedLineRanges'])
    row['bodyDisplayedLineCount']=sum(z-a+1 for a,z in row['bodyDisplayedLineRanges'])
    shown={i for a,z in row['bodyDisplayedLineRanges'] for i in range(a,z+1)}
    assert all(i in shown for a,z in row['selectedLineRanges'] for i in range(a,z+1)),p
    row['scope']='Ordinary accepted MCP name -> UI/IPC project override -> dotted-key mutation -> schema readback. No native/server connection, renderer target authority, locking or whole settings mechanism certification.'
    (historical if p.startswith('docs/') else files if p in semantic else nav).append(row)
write('source-manifest.json',dict(baseline='659b6b2ce5888723a40ce046cbbf643382cb130b',files=files,historicalReportReads=historical,navigationOnlyFiles=nav,hashOnlyFiles=[dict(path=p,bytes=len((ROOT/p).read_bytes()),sha256=sha((ROOT/p).read_bytes()),coverage='hash-only',timing='Previously read instructions reused at same SHA; this is not a new before-body pin.') for p in ['CODESHELL.md','AGENTS.md']],productExecution=0,fullMeaning='All product entries selected; display union and transitive reviewer evidence never auto-promote full.'))
finding=dict(id='MCP-R61-01',severity='P2',title='合法点号MCP名称的项目开关写出嵌套对象，导致后续配置读取失败',status='static-confirmed; runtime not validated',baseline='659b6b2ce5888723a40ce046cbbf643382cb130b',code_location=dict(absolute_file_path='/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/capability-control/service.ts',line_range=dict(start=161,end=164)),trigger='Existing ordinary current-version settings with a configured server named team.docs; use project capability on/off after ordinary target resolution and a successful settings write.',actual='setOverride joins an opaque server token into capabilityOverrides.mcp.team.docs. saveProjectSetting splits dots and persists {mcp:{team:{docs:"off"}}}; merge retains team as an object, but CapabilityOverridesSchema.mcp requires every record value to be inherit/on/off. getForScope then throws, and ordinary Desktop makeService settings.get/load can reject the merged project configuration.',expected='Persist the entire MCP server name as one literal record key; the produced settings must satisfy the same schema used by readback.',impact='A supported name and normal project switch can leave the project settings unreadable through validated settings APIs until the malformed override is corrected. More than a silently ignored override.',conditions=['Successful project settings mutation, normal current config version (2), and no higher layer explicitly removes this subtree.','Global MCP enable uses a whole record and is outside this defect. No claim that every migration/version/consumer fails.'],evidence=['Root159 ordinary UI -> preload -> IPC -> Desktop service -> core write chain selected source','Independent161 parser/sanitize, merge, schema, ordinary load and version-migration counterchecks','Independent160 bounded old-cause history review'],legacyRelationship='Same dotted-token representation family as completed archive plugin/Skill issue; that fix rejects old plugin/Skill dotted names, while current MCP names remain valid. Old SET-02 malformed-input schema gap and MCP-R38/39 editor args/rename are distinct entry contracts. Register this current MCP input once; 155 original exclusion and 158 candidate are retained as dated opinions.',execution='Static-only; no product/helper/import/schema/test/fixture/network/native/real settings execution.')
write('classification.json',dict(formal=[finding],candidates=[],related=[],promotion='Same prep155/158 line of inquiry registered once by Root; no extra candidate or related counter.',productRuns=0))
write('diagnostics.json',dict(firstSourceRead02='Requested range ended133 but actual file EOF120. First metadata wrapper raised IndexError before emitting a body file; original observed diagnostic and requested ranges preserved. Clamped actual ranges then saved; no product was run.',laterRead='One shell metadata read used a nonexistent renderer/components/settings path. sed stderr observed in tool transcript; aggregate shell exit0 because later commands succeeded. Correct renderer/settings path was already pinned/read in01 and was displayed in04. No fabricated standalone raw stdout/stderr.',presentation='A combined template/catalog metadata display exceeded tool output budget; only bounded follow-up template/key/row reads count as human inspection.',productFailureOrRerun=0))
(OUT/'report.md').write_text('''# Root159：点号MCP项目开关的静态正式判定

**1 formal /0 candidate /0 new related：MCP-R61-01 /P2。** 同一155/158线索只登记一次。当前基线659b6b2；没有运行产品函数、Zod、测试、fixture、真实设置、Host、native或网络。

正常名称`team.docs`经McpSection的非空/重复检查，以literal record key进入mcpServers；schema不拒点号，projectMcp据原名生成`mcp:team.docs`。CapabilitiesOverview261–271将原id发给preload1119–1123，main3840–3847只查id是string及三态枚举，再由Desktop114–120调用项目覆盖。Core service161–164却把完整token拼成点分配置路径；manager83–91/144–155拆点，572–584与872–890直接把嵌套对象写入项目settings并invalidate，没有shape validation。

应写的`mcp["team.docs"]="off"`变为`mcp.team.docs="off"`。manager1109–1139的merge保留对象，schema57–78的mcp record(enum)拒绝`team:{docs:"off"}`，getForScope701–709直接parse抛错。普通load393/validateMerged501–502和Desktop makeService51–54也读取验证后的settings；UI随后load会遇到错误。独立161补核普通JSON parser/sanitize、current configVersion=2迁移与普通load，支持此P2影响，未借旧silent-inherit文字代替当前验证行为。

反证边界保留：overlay effectiveProjectOverrides的catch只能保护它自身，不覆盖service.list107–109的直接getForScope，也不覆盖Desktop makeService先settings.get；全局MCP路径174–179写whole record，不能泛化成所有MCP开关。只断言普通当前版本配置、写入成功、没有更高层显式删除该子树；未认证所有迁移、所有读取方或配置target授权。

原archive1–7明确已完成并保留修复前问题，36–45只描述plugin/Skill点号名称。旧修复拒绝这些名字，不能覆盖当前仍合法的MCP producer。155原0/同helper排旧观点保持冻件，158后修正为同项candidate，160有限历史核对未建立相同当前MCP入口记录；这不声称全史根因穷尽。Root将当前入口单独登记一次，不改变原118记录。

[分类与完整条件](classification.json)、[逐源选段](source-manifest.json)、[实际正文01](source-read-01.txt)、[正文02](source-read-02.txt)、[正文03](source-read-03.txt)、[正文04](source-read-04.txt)、[元数据诊断](diagnostics.json)。所有产品都是selected，完整显示/旧重复/导航与hash不升级full。原首个范围越界元数据错误及后续路径显示错误如实保留，无产品首失败或重试。
''')
write('ending-checks.json',dict(files=len(pins),changed=[],allPinnedSourceBytesUnchanged=True,productRuns=0,gitRuns=0))
rows=[]
for p in sorted(OUT.rglob('*')):
    if p.is_file() and p.name!='artifact-receipt.json':
        raw=p.read_bytes();rows.append(dict(path=str(p.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
write('artifact-receipt.json',dict(frozenUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),selfExcluded=True,files=rows))
print(json.dumps(dict(files=len(rows)+1,productRuns=0,formal=1,anchors=[dict(path=name,bytes=len((OUT/name).read_bytes()),sha256=sha((OUT/name).read_bytes())) for name in ['report.md','source-manifest.json','artifact-receipt.json']]),ensure_ascii=False))
