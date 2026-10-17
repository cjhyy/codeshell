from pathlib import Path
import hashlib,json,subprocess

root=Path.cwd();out=root/'docs/audit-2026-10-17-round21/evidence';base='615e4e4dd3a61b1ad132ab4f3683985a0d582386'
selected=[
 ('packages/core/src/context/tool-output-budget.ts',['1-173 (full source)'],'actual runtime leaf, no mock/extraction'),
 ('packages/core/src/context/token-counter.ts',['1-133 (full source)'],'actual runtime dependency; only estimateStringTokens called by audit/helper, no provider tokenizer'),
 ('packages/core/src/context/tool-output-budget.test.ts',['1-134 (full source)'],'existing 8 pure leaf tests; fixed default-cap CJK case about29k chars, no pressure/stress experiment'),
 ('packages/core/src/types.ts',['1-120'],'selected type-only ContentBlock/ToolResult contracts; runtime erased'),
 ('packages/core/src/context/manager.ts',['1-105','786-829','407 (call-site rg)','535 (call-site rg)','683 (call-site rg)'],'selected ordinary default budget/caller static only; not imported'),
 ('packages/core/src/context/compaction.ts',['727-803'],'selected ordinary aggregate backstop and positive600chars/200tokens budget static only; not imported'),
 ('packages/core/src/context/tool-result-storage.ts',['180-220','330-420'],'selected preview/persistence budget caller static only; not imported/no storage operation'),
 ('packages/core/src/context/tool-result-budget.test.ts',['1-60 (full source)'],'existing aggregate/old magic-200 regression static only; never imported or executed'),
 ('packages/core/src/tool-system/mcp-results.ts',['1-97 (full source)'],'auxiliary response shape inspection static only; no MCP import/network/size enforcement execution'),
 ('packages/core/src/tool-system/registry.ts',['250-270'],'selected contentBlocks forwarding static only; not imported or executed'),
 ('packages/core/src/engine/turn-loop.ts',['240-260'],'selected toolResultToBlock forwarding static only; not imported or executed'),
]
files=[]
for path,ranges,kind in selected:
 data=(root/path).read_bytes();frozen=subprocess.run(['git','show',f'{base}:{path}'],capture_output=True,check=True).stdout
 files.append({'path':path,'frozenSha256':hashlib.sha256(frozen).hexdigest(),'currentSha256':hashlib.sha256(data).hexdigest(),'matchesFrozen':data==frozen,'bytes':len(data),'lineCount':len(data.splitlines()),'ranges':ranges,'kind':kind})
assert all(x['matchesFrozen'] for x in files)
fixture=root/'docs/audit-2026-10-17-round21/evidence/toolbudget-focused.test.ts'
assert fixture.is_file()
for path in ['packages/core/src/context/tool-output-budget.ts','packages/core/src/context/token-counter.ts']:
 text=(root/path).read_text()
 assert 'node:' not in text and 'import {' not in text.replace('import { estimateStringTokens } from "./token-counter.js";','')
obj={'base':base,'files':files,'limitations':'Only tool-output-budget and token-counter actual leaf logic execute. All other selected sources are static only; no ContextManager/compaction/storage/Engine/provider subsystem runtime coverage.'}
(out/'toolbudget-source-manifest.json').write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
preflight={'base':base,'passed':True,'sourceBytePinsChecked':len(files),'sourceManifest':'docs/audit-2026-10-17-round21/evidence/toolbudget-source-manifest.json','fixture':str(fixture.relative_to(root)),'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'existingTest':'packages/core/src/context/tool-output-budget.test.ts','leafAbsoluteImport':str(root/'packages/core/src/context/tool-output-budget.ts'),'runtimeClosure':['tool-output-budget.ts','token-counter.ts'],'imports':'Leaf actual runtime imports token-counter only; types imports erased; no runtime mocks/extraction or guessed node_modules paths.','ownedInputScope':'bounded strings,302 handbuilt single-character text blocks (<1k joined chars), image marker objects without real bytes; existing fixed default30k-cap sample retained.','firstRunPolicy':'Single guarded existing+focused shard; combined raw stdout/stderr and exit receipt saved before inspection; any failure skips entire dynamic direction without repairs/reruns/alternate validation.','excluded':['ContextManager/compaction/storage/Engine/provider/network/files/native real execution','old JSON summary repair failed direction','old aggregate magic-200 and structured summary findings not recovered','new Unicode direction/performance/pressure/stress','0/negative/NaN budget inventions'],'productChanges':False}
(out/'toolbudget-preflight.json').write_text(json.dumps(preflight,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':True,'pins':len(files),'fixtureSha256':preflight['fixtureSha256'],'actualLineCounts':{x['path']:x['lineCount'] for x in files}},ensure_ascii=False))
