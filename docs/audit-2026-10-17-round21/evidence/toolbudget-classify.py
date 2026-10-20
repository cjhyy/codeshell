from pathlib import Path
import json

root=Path.cwd();out=root/'docs/audit-2026-10-17-round21/evidence';base='615e4e4dd3a61b1ad132ab4f3683985a0d582386'
def save(name,obj):(out/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
save('toolbudget-findings.json',[])
save('toolbudget-candidates.json',[])
save('toolbudget-related.json',[
 {'id':'BUDGET-R21-R1','title':'Structured text-slot separators retain a floor above the real backstop allowance; concrete helper edge related to prior budget-floor concern','classification':'related prior source concern, no new formal/candidate count','file':'packages/core/src/context/tool-output-budget.ts','lines':[78,106],'oldRecord':'docs/audit-2026-10-17-round4/context.md:41','oldRecordStatus':'source concern only; no prior formal finding or candidate ID','ordinaryCallerSource':'packages/core/src/context/compaction.ts:773-776 supplies600 chars/200 heuristic tokens only after aggregate pressure','actualObservation':'Actual createToolTextReplacement/replaceToolResultText,302 owned text slots containing x: joined original904chars, final302 empty slots joined as602 newlines,151 heuristic tokens, exceeds600char budget=true.301slot control final600chars,150heuristic tokens, exceeds=false.','inputProvenance':'Handcrafted valid ContentBlock array, not an observed normal302-slot tool producer. No image bytes, tool invocation, provider or authority input.','limitations':['Actual compaction/ContextManager/storage/Engine not imported or run','Ordinary302-slot producer and aggregate gate reachability not established','No real provider token count/context overflow/UI impact proven','No0/negative/NaN budget inputs; exact real positive600/200 helper allowance only'],'evidence':['docs/audit-2026-10-17-round21/evidence/toolbudget-focused.test.ts','docs/audit-2026-10-17-round21/evidence/toolbudget-first.raw.log','docs/audit-2026-10-17-round21/evidence/toolbudget-first.exit.json'],'correctionDirection':'If later confirmed ordinary, preserve positional slot metadata while bounding the materialized joined view or explicitly represent an unavoidable floor; no fix made.'}
])
save('toolbudget-dedup-decisions.json',{
 'base':base,'fullCorpus':'docs/audit-2026-10-17-round21/evidence/toolbudget-dedup.json',
 'selectedRecords':[
 {'path':'docs/audit-2026-10-17-round4/context.md','lines':[21,43],'decision':'CTX-2 structured summary text omission and CTX-1 call/result pairing are separate old findings, excluded entirely. Existing source concern line41 covers an unavoidable aggregate floor; current within-result separator floor is concrete helper evidence linked conservatively to that concern, not a new counted candidate.'},
 {'path':'docs/archive/review-2026-05-30/findings.json','locator':'$[28]','title':'Underestimated replacement size in applyToolResultBudget','decision':'Old magic-200 accounting root cause excluded; current static caller subtracts actual replaced.text.length. No aggregate runtime or old regression rerun.'},
 {'path':'docs/archive/review-2026-05-30/backlog_confirmed.json','locator':'$[5]','decision':'Same old magic-200 finding/verified-note record; not the present within-result separator accounting, no new formal count.'},
 {'path':'docs/archive/review-2026-05-30/backlog_verdicts.json','locator':'$[14]','decision':'Same old accounting mechanism; no additional finding.'},
 {'path':'docs/audit-2026-10-17-round12/README.md','decision':'Prior UTF16 truncation mechanism excluded; existing leaf Unicode regressions run as existing controls only, no new Unicode exploration or claim.'},
 {'path':'docs/audit-2026-10-17-round20/toolsummary.md','decision':'Old JSON summary repair failure and tool-summary non-Error related issue remain excluded; neither summary implementation imported.'},
 ],
 'keywordLimitations':'Full recursive JSON scalar and Markdown traversal includes archives. Bounded contexts and total hits locate semantic review only; no proof of corpus-wide semantic exhaustion.'
})
save('toolbudget-metadata-notes.json',{
 'scope':'Metadata-only navigation/transcription; no product rerun or replacement validation',
 'events':[
 {'command':'rg -n createToolTextReplacement|... packages/core/src/context packages/core/src/settings packages/core/src/tools','exitCode':2,'firstResponseTranscription':'rg: packages/core/src/tools: No such file or directory (os error 2)','disposition':'Guessed absent auxiliary directory skipped. Actual tool-system filenames later discovered with rg --files; not a Bun import/dependency/product failure.'},
 {'command':'cat existing toolsummary receipts; sed -n 1,240p docs/audit-2026-10-17-round20/tool-summary.md','exitCode':1,'firstResponseTranscription':'sed: docs/audit-2026-10-17-round20/tool-summary.md: No such file or directory','disposition':'Wrong old report spelling skipped; subsequent read uses report path given by its actual artifact receipt,toolsummary.md. No product execution.'},
 {'command':'Combined static selected old context report + archive source + JSON records','exitCode':0,'firstResponseTranscription':'Warning: truncated output (original token count: 7999); tool output capped at6000 tokens','disposition':'No hidden product output involved. Important old floor line and current compaction source re-read bounded; selected old magic-200 JSON record text visible in original response. Full source files remain on disk.'},
 {'command':'toolbudget-preflight.py','exitCode':0,'disposition':'Initial full-source range labels exceeded actual file endings; actual measured lineCount corrected labels before product run and metadata preflight re-evaluated. Source bytes/fixture were unchanged; no test run had occurred.'},
 ],
 'rawEvidence':'Toolbudget raw test stdout/stderr and exit were saved before first inspection and never rewritten.',
 'testReruns':0
})
command=['node','scripts/run-bun-test-shard.mjs','--timeout','30000','packages/core/src/context/tool-output-budget.test.ts','docs/audit-2026-10-17-round21/evidence/toolbudget-focused.test.ts']
save('toolbudget-validation.json',{
 'base':base,'formalCount':0,'candidateCount':0,'relatedCount':1,
 'runs':[{'command':command,'exitCode':0,'raw':'docs/audit-2026-10-17-round21/evidence/toolbudget-first.raw.log','exit':'docs/audit-2026-10-17-round21/evidence/toolbudget-first.exit.json','completed':True,'pass':18,'expect':94,'fail':0,'skipped':0,'existingTests':8,'focusedTests':10,'ordinaryFocusedControls':8,'handcraftedBoundaryControlTests':1,'handcraftedRelatedEdgeTests':1,'actualProductionLeafCalls':True,'manualMirroredRecipe':False,'firstAttempt':True}],
 'cleanTotals':{'runs':1,'pass':18,'expect':94,'fail':0,'skipped':0,'existingTests':8,'focusedTests':10},
 'failedShards':0,'reruns':0,'productChanges':False,
 'firstRunHandling':'Combined raw stdout/stderr and exit JSON saved before inspection; single clean guarded shard. Fixture unchanged after preflight/run.',
 'scope':'Actual tool-output-budget leaf+actual heuristic estimateStringTokens; owned small strings/typed blocks. Existing fixed default30k-cap test included, no pressure experiment. No runtime mocks or source extraction.',
 'skippedDirections':['All previous failed directions unchanged,especially JSON summary repair','ContextManager/compaction/storage/Engine/providers coupled runtime and existing aggregate test not run','New Unicode/grapheme investigation and old magic-200/structured summary findings excluded'],
 'excluded':['Real provider tokenizer/token prices/models/paid APIs/network/actualtools/userdata/native/security/custody','0/negative/NaN budget inventions','performance/largeinput pressure','broad build/typecheck/lint/full suite'],
 'metadataFailures':'See toolbudget-metadata-notes.json; wrong navigation and truncated auxiliary static output, not product failures.'
})
print(json.dumps({'saved':'classifications/validation','formal':0,'candidate':0,'related':1,'pass':18,'expect':94}))
