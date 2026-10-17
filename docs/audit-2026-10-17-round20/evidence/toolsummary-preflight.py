from pathlib import Path
import hashlib,json,subprocess
root=Path.cwd();out=root/'docs/audit-2026-10-17-round20/evidence';base='d40dd06987a2e0c20c377e243cf5c4e4b549c9ec'
selected=[
 ('packages/core/src/engine/tool-summary.ts',['1-51 (full source)'],'actual runtime leaf; all production logic retained'),
 ('packages/core/src/types.ts',['1-120'],'selected type-only ToolCall/ToolResult contracts; not runtime imported'),
 ('packages/core/src/logging/logger.ts',['1-190'],'selected logger side-effect/dependency review; exact module replaced by warn-only memory mock before leaf import; real logger not imported'),
 ('packages/core/src/engine/turn-loop.ts',['1660-1735'],'selected ordinary caller static only; no TurnLoop import/run'),
 ('packages/core/src/engine/run-accounting.ts',['130-171'],'selected real summarize producer static only; no model/provider/client calls'),
 ('packages/core/src/engine/model-facade.ts',['250-275'],'selected callback slot static only'),
 ('packages/core/src/engine/streaming-tool-queue.ts',['1-140 (full source)'],'ordinary ordering static only; not imported'),
 ('packages/core/src/tool-system/registry.ts',['230-285'],'ordinary success/error shape static only; not imported or executed'),
 ('packages/core/src/tool-system/tool-result-redaction.ts',['1-51 (full source)'],'display-result pass-through static only; no sensitive or authority experiments'),
 ('packages/core/src/engine/turn-loop-tool-summary.test.ts',['1-115 (full source)'],'existing coupled test read only; never imported or executed'),
]
files=[]
for path,ranges,kind in selected:
 data=(root/path).read_bytes();frozen=subprocess.run(['git','show',f'{base}:{path}'],capture_output=True,check=True).stdout
 files.append({'path':path,'frozenSha256':hashlib.sha256(frozen).hexdigest(),'currentSha256':hashlib.sha256(data).hexdigest(),'matchesFrozen':data==frozen,'bytes':len(data),'lineCount':len(data.splitlines()),'ranges':ranges,'kind':kind})
assert all(x['matchesFrozen'] for x in files)
leaf=(root/selected[0][0]).read_text(); assert 'import { logger } from "../logging/logger.js";' in leaf
fixture=root/'docs/audit-2026-10-17-round20/evidence/toolsummary-focused.test.ts';assert fixture.is_file()
obj={'base':base,'files':files,'limitations':'Only tool-summary.ts actual leaf executes; logger mock only, type-only imports erased. Other listed sources are scoped static reads, not whole subsystem execution.'}
(out/'toolsummary-source-manifest.json').write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
p={'base':base,'passed':True,'sourceBytePinsChecked':len(files),'sourceManifest':'docs/audit-2026-10-17-round20/evidence/toolsummary-source-manifest.json','fixture':str(fixture.relative_to(root)),'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'leafAbsoluteImport':str(root/selected[0][0]),'loggerExactPreimportMock':str(root/selected[2][0]),'loggerMockExports':'logger.warn only; in-memory recording','observedRuntimeImports':['../logging/logger.js'],'observedTypeOnlyImports':['../types.js'],'leafTopLevel':'constant system prompt and function declaration only; no product filesystem/network/timer work','dependencyResolution':'No guessed node_modules package preflight; actual guarded Bun import not run yet','forbiddenDirectionsExcluded':['old failed JSON summary repair','actual model/provider/Engine/TurnLoop dynamic execution','coupled turn-loop tests','paid/network/realtools/userdata/native/timers/security/custody'],'firstRunPolicy':'Persist combined raw stdout/stderr and exit JSON before reading; any nonzero/failure => entire leaf dynamic direction skipped without edits/retry/alternate validation.'}
(out/'toolsummary-preflight.json').write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'preflight':'saved','sourceBytePins':len(files),'matchesFrozen':all(x['matchesFrozen'] for x in files),'leafLineCount':files[0]['lineCount']},ensure_ascii=False))
