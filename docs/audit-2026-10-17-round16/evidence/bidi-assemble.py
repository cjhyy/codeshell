"""Metadata assembly only. No product imports, tests, resolver or runtime retries."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
BASE='ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f'
def sha(raw): return hashlib.sha256(raw).hexdigest()
def write(name,value): (HERE/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
source=(ROOT/'packages/tui/src/render/bidi.ts').read_text()
header='function hasRTLCharacters(text: string): boolean {'
original=source[source.index(header):].strip()
compiled=original.replace(header,'function hasRTLCharacters(text) {')
wrapper=compiled+'\nreturn hasRTLCharacters;'
(HERE/'bidi-compiled-predicate.js').write_text(compiled+'\n')
write('bidi-extraction.json',{'frozenBase':BASE,'sourcePath':'packages/tui/src/render/bidi.ts','lines':[132,140],'inputFunctionSha256':sha(original.encode()),'compiledFunctionSha256':sha(compiled.encode()),'actualNewFunctionArgumentSha256':sha(wrapper.encode()),'compiledTextArtifact':'docs/audit-2026-10-17-round16/evidence/bidi-compiled-predicate.js','artifactIncludesTrailingNewline':True,'transformation':'Only the two TypeScript signature annotations removed. Regex/body copied unchanged. New Function returns the predicate.','actualProductModuleImported':False,'platformGateExecuted':False,'bidiJsImported':False})
write('bidi-findings.json',[])
write('bidi-candidates.json',[
 {'id':'BIDI-R16-C1','status':'candidate','title':'Hard-coded RTL fast filter excludes Adlam strong RTL letters','frozenBase':BASE,'source':'packages/tui/src/render/bidi.ts:132','consumer':'packages/tui/src/render/bidi.ts:63','evidence':'Exact frozen-source predicate returns false for U+1E900/U+1E901; returns true when ordinary Hebrew appended. Unicode DerivedBidiClass marks 1E900..1E943 as R.','execution':'source-extracted predicate only; no actual module export or bidi-js call','ordinaryInput':'Two normal Adlam Unicode letters; no explicit formatting control needed.','limits':'Platform gate, complete reorder, font/terminal display and explicit current Adlam product support contract were not verified. Candidate only.','externalContract':'https://www.unicode.org/Public/UCD/latest/ucd/extracted/DerivedBidiClass.txt','formalSeverity':None},
 {'id':'BIDI-R16-C2','status':'candidate','title':'No mirroring step visible in object-only bidi permutation','frozenBase':BASE,'source':'packages/tui/src/render/bidi.ts:67','consumer':'packages/tui/src/render/output.ts:805','evidence':'Static function returns original value fields after object permutation; direct Output consumer passes value to setCellAt. UAX #9 L4/section 7 requires mirrored glyph handling for odd resolved levels.','execution':'source only; the embedding levels and reordered result for parenthesized Hebrew were not executed','ordinaryInput':'Parenthesized ordinary Hebrew text such as (שלום), only an illustrative unexecuted input.','limits':'No verified downstream font/terminal mirroring contract; no observed bad bracket output. Candidate only, not a claim that code-point substitution is always required.','externalContract':'https://www.unicode.org/reports/tr9/','formalSeverity':None}
])
write('bidi-validation.json',{'frozenBase':BASE,'formalCount':0,'candidateCount':2,'relatedCount':0,'firstExecutions':[{'command':['node','scripts/run-bun-test-shard.mjs','--timeout','30000','docs/audit-2026-10-17-round16/evidence/bidi-predicate.test.ts'],'rawLog':'docs/audit-2026-10-17-round16/evidence/bidi-predicate.first.raw.log','exitReceipt':'docs/audit-2026-10-17-round16/evidence/bidi-predicate.first.exit.json','exitCode':0,'guardCompleted':True,'testsPassed':7,'expectations':21,'testsFailed':0,'testsSkipped':0,'existingTests':0,'focusedTests':7,'attempts':1,'reruns':0,'scope':'Exact source-extracted hasRTLCharacters predicate; no actual module export/platform gate/library/terminal.'}],'cleanShards':1,'failedBunShards':0,'successfulTests':7,'expectations':21,'existingTests':0,'focusedTests':7,'skippedDirections':[],'metadataPreflightFailures':[],'productReruns':0,'actualProductModuleImported':False,'fullBidiAlgorithmExecuted':False,'platformGateExecuted':False})
write('bidi-external-contracts.json',{'observedOn':'2026-10-17','tools':'web open/find only; no runtime network in fixture','sources':[{'url':'https://www.unicode.org/Public/UCD/latest/ucd/extracted/DerivedBidiClass.txt','observation':'1E900..1E943 is explicitly assigned Bidi_Class R; the fixture uses 1E900 and 1E901.','scope':'Directional property only, not proof of this package dependency version supporting the characters or terminal/font rendering.'},{'url':'https://www.unicode.org/reports/tr9/','versionObserved':'Unicode 18.0.0; Revision 52; 2026-09-01','observation':'Section 3.4 L4 and section 7 describe mirrored glyph behavior for characters at odd resolved embedding levels.','scope':'Display contract only; no terminal/backend experiment, and no claim that every renderer must substitute Unicode code points.'}]})
scopes={
'CODESHELL.md':'Full read repository instructions; no product execution.',
'AGENTS.md':'Root instruction alias; workflow handled by parent.',
'packages/tui/src/render/bidi.ts':'Fully read. Exact lines 132-140 predicate source extracted and compiled; no actual export, getBidi, needsBidi, library or complete algorithm execution.',
'packages/tui/src/render/output.ts':'Selected static excerpts: ClusteredChar fields, line splitting, style/grapheme production, reorderBidi call and direct cell write; no Output import or screen rendering.',
'packages/tui/src/render/stringWidth.ts':'First 150 lines static source only, no width helper import/execution or correctness claim.',
'packages/tui/src/render/README.md':'Full read renderer internal API/ownership contract; no benchmarks or runtime.',
'packages/tui/package.json':'Static dependency declaration and package boundaries only; no resolver/install checks.',
'bun.lock':'Selected bidi-js manifest entries only; whole-file hash is source identity, not whole-file review.',
'scripts/run-bun-test-shard.mjs':'Read small wrapper and invoked guarded runner once; no broad suite.'
}
records=[]
for path,scope in scopes.items():
 frozen=subprocess.run(['git','show',f'{BASE}:{path}'],cwd=ROOT,check=True,stdout=subprocess.PIPE).stdout
 current=(ROOT/path).read_bytes()
 records.append({'path':path,'frozenBytes':len(frozen),'frozenSha256':sha(frozen),'currentSha256':sha(current),'currentMatchesFrozen':current==frozen,'scope':scope})
write('bidi-source-manifest.json',{'frozenBase':BASE,'sources':records})
paths=[ROOT/'docs/audit-2026-10-17-round16/bidi.md',*sorted(HERE.glob('bidi-*'))]
paths=[p for p in paths if p.is_file() and p.name!='bidi-artifact-receipt.json']
write('bidi-artifact-receipt.json',{'frozenBase':BASE,'report':'docs/audit-2026-10-17-round16/bidi.md','formalCount':0,'candidateCount':2,'relatedCount':0,'rawLogs':['docs/audit-2026-10-17-round16/evidence/bidi-predicate.first.raw.log'],'artifactCount':len(paths),'artifacts':[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in paths]})
print(json.dumps({'formal':0,'candidates':2,'sourcePins':len(records),'artifacts':len(paths)}))
