from pathlib import Path
import datetime
import hashlib
import json

root = Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
out = Path('/tmp/codeshell-audit-round26-frontier')

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def save(name, value):
    (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

scopes = [
    ('CODESHELL.md', 'full', None, 'Instructions; full read earlier in same audit task and unchanged digest checked at round26 start.'),
    ('packages/web/src/lib/connectionLiveness.ts', 'full', None, 'Static client connection-health state considered. Real timer/transport lifecycle: not a future pure-data execution recommendation.'),
    ('packages/web/src/hooks/useRemoteSocket.ts', 'selected', [[1,145]], 'Actual ConnectionLiveness import/constructor wiring only; hook/socket/storage/auth functions never invoked.'),
    ('packages/coding/src/cc-orchestrator/codex-user-text.ts', 'full', None, 'Zero-import user-text helper considered. Known leading-context removal has actual consumers; no independent ordinary producer violation established.'),
    ('packages/coding/src/external-runtimes/turn-input.ts', 'full', None, 'Pure reference-string builder considered; no new independent defect, attachment scope excluded.'),
    ('packages/coding/src/cc-orchestrator/codex-session-history.ts', 'selected', [[45,87],[98,123]], 'Actual history/live user-text consumers only; no parser, file I/O, real transcript or user HOME access.'),
    ('packages/coding/src/cc-orchestrator/codex-session-discovery.ts', 'selected', [[354,398]], 'Documented parts shape and title consumer only. Original sed upper bound400 ended at actual EOF398; no source loss or failure.')
]
rows = []
snapshots = []
for path, coverage, ranges, note in scopes:
    raw = (root/path).read_bytes()
    lines = raw.decode().splitlines(keepends=True)
    if ranges is None:
        ranges = [[1,len(lines)]]
    if not all(1 <= a <= b <= len(lines) for a,b in ranges):
        raise ValueError('Unexpected metadata range: '+path)
    rows.append({'path':path,'coverage':coverage,'selectedLineRanges':ranges,
                 'lineCount':len(lines),'coveredLineCount':sum(b-a+1 for a,b in ranges),
                 'bytes':len(raw),'firstCapturedSha256':sha(raw),'currentSha256':sha(raw),
                 'frozenSha256':None,'frozenGitBlob':None,
                 'role':'instruction' if path=='CODESHELL.md' else 'considered-static-source','note':note})
    snapshots.append({'path':path,'sha256':sha(raw),'ranges':[{'start':a,'end':b,'text':''.join(lines[a-1:b])} for a,b in ranges]})
manifest = {
    'worktree':str(root),
    'parentReportedOldRound25Freeze':'8b9677c78d150abe9681a2f65ab8e55b1288be4b',
    'parentReportedCurrentHeadAfterFF':'d9d2c33ddd1b2edea28a719e4cd0a505a96c0b08',
    'headVerifiedByGit':False,'gitCommands':0,
    'firstHashCaptureUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'initialSemanticReadSha256':None,
    'hashChronology':'Initial tool text reads did not separately save first-read hashes. First captured filesystem pins here are after all selected reads and parent FF notice; do not reconstruct pre-FF hashes or label all sources8b.',
    'initialReadChronology':{'connectionLivenessAndUseRemoteSocket':'Read before parent FF notice; first semantic-read SHA unavailable.','codexUserTextTurnInputAndSelectedCallers':'Read after parent FF notice; filesystem-only pin.'},
    'sources':rows,'sourcePinCount':len(rows),'newProductSourceCount':6,
    'semanticReadLineCountWithoutInstruction':sum(r['coveredLineCount'] for r in rows if r['role']!='instruction'),
    'sourceScopeRule':'Hashes pin entire file bytes. Only declared full/selected scope is semantic reading; source sections already read are not counted twice.',
    'frozenComparison':'Not performed: parent required0Git. Future adoption requires Root to establish its new frozen/current/main comparison.'}
save('source-manifest.json',manifest)
save('selected-source.json',{'kind':'Current selected source text at first captured filesystem pins, not reconstructed pre-FF bytes','sources':snapshots})

history = json.loads((out/'history.json').read_text())
supplement = json.loads((out/'history-supplement.json').read_text())
notes = {
    'productAttempts':0,'testAttempts':0,'runtimeImports':0,'fixturesWritten':0,'gitCommands':0,
    'currentRound25Writes':0,'metadataFailureCount':1,
    'metadataFailures':[{'id':'FRONTIER26-META-01','stage':'source-range assertion before final manifest write','exitCode':1,
                        'firstResponse':'metadata-first-responses.json','responseFidelity':'Manual visible-response transcription; not original process raw, not saved before inspection.',
                        'cause':'The prior sed command requested354..400 but codex-session-discovery.ts ends at398. Range metadata initially used400 and assertion rejected it.',
                        'correction':'Metadata only: actual selected scope354..398, preserving original command upper bound in notes. No product, fixture, test, import or Git operation.'}],
    'inventoryAndDedup':'First8 history groups then2additional targeted groups. Both2506-path inventories and counts identical; these were static metadata searches, not product retries.',
    'historySnapshotLimits':'Broad history snapshot was captured while Root was finishing round25; parent later reportedFF to d9d2. Its inventory/hash list records actual per-file read point, not globally atomic Git state. Supplemental search revisited the same2506paths. Re-inventory current history before any future formal classification.',
    'sourceHashLimits':'Initial semantic-read SHA was not separately captured. Post-FF first filesystem pin and finish pin are recorded separately; no Git frozen blob is claimed.',
    'zeroExecutionBoundary':'Only metadata Python/rg/text reads. No product test/import/function call, fixture, VM/AST/eval, real timer/socket/native/network/model/account/auth/security/custody/identity or real user HOME experiment. Source declarations mentioning such operations were read as text only.',
    'round25Separation':'No changes to frozen round25 author/prep/raw/fixture/receipt. Nothing here contributes to round25 test/source/artifact totals.'}
save('metadata-notes.json',notes)
proposal = {
    'status':'negative proposal; no new independent ordinary-producer contract violation established',
    'outputDirectory':str(out),'round25Contribution':False,
    'formalCount':0,'candidateCount':0,'relatedCount':0,
    'inventory':{'paths':len(json.loads((out/'inventory.json').read_text())['paths']),'directories':['packages/core/src/prompt','packages/web/src','packages/coding/src'],'beforeSourceReview':True},
    'history':{'roots':['docs','bugs'],'archivesIncluded':True,'round25Included':True,'totals':history['totals'],
               'matchCounts':history['matchCounts'],'retainedContexts':history['retainedContexts'],
               'supplementMatchCounts':supplement['matchCounts'],'supplementRetainedContexts':supplement['retainedContexts'],
               'limitations':['Broad groups are capped at180 contexts, supplemental groups at100. Counts exceed retained contexts in some groups; no semantic-exhaustion claim.',
                              'JSON scalar values searched recursively, not keys. Snapshot is per-file, not Git-verified global atomic history. Future adoption must refresh history after integration.']},
    'consideredFrontiers':[
        {'path':'packages/web/src/lib/connectionLiveness.ts','decision':'Not selected','ordinaryChain':'useRemoteSocket imports the class and constructs one per socket; selected1..145 confirms real transport/lifecycle coupling.',
         'counterevidence':'Revision/stopped/paused guards, arm-before-send and single-flight probing are explicit source choices. No concrete ordinary producer violated a separate contract during static review.',
         'dynamicBoundary':'Zero imports are not sufficient to make constructor safe pure data: it arms real timers. No constructor/timer/probe/socket/auth test or fake timer suggested.'},
        {'path':'packages/coding/src/cc-orchestrator/codex-user-text.ts','decision':'No new issue / no test recommendation',
         'ordinaryChain':'Actual parseCodexRecentHistory and parseCodexTranscriptLine call codexUserText for user payload content; firstUserMessageFromPrefix calls it for title text. Only selected source read, no actual transcript/user data loaded.',
         'contract':'Retain user-authored parts while discarding known leading host parts, and strip complete leading Page snapshots while preserving following prompt.',
         'counterevidence':'Complete-leading-page regex and separate per-part mapping directly serve the stated ordinary shape. A deliberately host-prefixed literal user string is not sufficient evidence of a producer defect; no new normal writer shape violating this contract was established.',
         'oldScope':'Existing room/history/mapper titles and failed projection/replay directions remain excluded. No claim that this isolated helper validates complete room projection.'},
        {'path':'packages/coding/src/external-runtimes/turn-input.ts','decision':'No new issue; attachment direction excluded',
         'ordinaryChain':'Inventory query finds textWithAttachmentReferences called by both Codex and Claude Code runtime source; runtime callers were not semantically read or invoked.',
         'counterevidence':'The helper explicitly returns original text when no nonblank reference and appends ordinary path references otherwise. No unsupported input shape is generalized to a user failure; no path/attachment/security test suggested.'}
    ],
    'historyExclusions':[
        {'prior':'SectionCache and prompt composition','evidence':['docs/audit-2026-10-17-round25/frontier-selection.md:7','docs/audit-2026-10-17-round23/product-report.md:21'],
         'decision':'SectionCache already round5 actual coverage, prompt customPrompt/sections precedence oldPRODUCT-R23-R1. No cache baseline or model-wish experiment repeated.'},
        {'prior':'messageMappers/userMessageDisplay/output projections','evidence':['docs/audit-2026-10-17-round17/mappers.md:21','docs/audit-2026-10-17-round14/web.md','docs/audit-2026-10-17-round18/unread.md'],
         'decision':'Existing mapper/legacy text/newline or old unproven snapshot-live/unread candidate scope. Do not manufacture new reducer failure from isolated objects or replay old failed group.'},
        {'prior':'model trace presentation/API','evidence':['docs/audit-2026-10-17-round18/presentation.md','docs/audit-2026-10-17-round18/traceapi.md'],'decision':'Already read and tested prior round; no new baseline repetition.'},
        {'prior':'NotebookEdit','evidence':['docs/review-remaining-2026-10-12/coding-tui-chat.md:152','docs/review-remaining-2026-10-12/coding-tui-chat.md:160'],'decision':'Existing C9 string-form source and C10 replace metadata/id mechanisms excluded; no tool/FS experiment.'},
        {'prior':'Git parse-log/slug, review prompt, changed-file parser','evidence':['docs/audit-2026-10-17-round13/git-text.md','docs/audit-2026-10-17-round19/reviewprompt-report.md','docs/audit-2026-10-17/root.md:73'],'decision':'Previously covered parse-log/slug and review alias/fences/UTF16/Move-to mechanisms; no Git, patch, parser or baseline execution.'},
        {'prior':'All old failed LSP/patch/grep/read/Edit, memory-sort, ANSI, i18n and authority directions','decision':'Remain skipped. No wrappers, alternative validation or neighboring broad suite used to recover them.'}
    ],
    'nextStep':{'recommendNewDynamicLane':False,'reason':'No independent new ordinary producer+contract contradiction warrants another test. Pure codexUserText could be a bounded leaf only if Root later establishes a new specific writer-contract gap; do not execute just to add controls.',
                'requiresNewAuthorizationAndFreeze':True,'fixturesWritten':False,'testsRun':False},
    'sourceManifest':'source-manifest.json','metadataNotes':'metadata-notes.json',
    'productAttempts':0,'testAttempts':0,'runtimeImports':0,'fixturesWritten':0,'vmAstEvaluations':0,
    'nativeExperiments':0,'networkRequests':0,'authSecurityExperiments':0,'realHomeAccess':0,'gitCommands':0,'round25Writes':0}
save('proposal.json',proposal)

finish = []
for row in rows:
    raw = (root/row['path']).read_bytes()
    h = sha(raw)
    finish.append({'path':row['path'],'firstCapturedSha256':row['firstCapturedSha256'],'finishSha256':h,'matchesFirstCaptured':h==row['firstCapturedSha256']})
save('finish-check.json',{'finishUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          'parentReportedCurrentHead':'d9d2c33ddd1b2edea28a719e4cd0a505a96c0b08','headVerifiedByGit':False,
                          'sourceChecks':finish,'allMatchFirstCaptured':all(r['matchesFirstCaptured'] for r in finish),
                          'initialSemanticReadHashUnavailable':True,'sourcePins':len(rows),'consideredSourceLines':manifest['semanticReadLineCountWithoutInstruction'],
                          'metadataOnlyFailureCount':1,'productAttempts':0,'testsRun':0,'gitCommands':0})
paths = sorted(p for p in out.iterdir() if p.is_file() and p.name!='artifacts.json')
files = [{'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in paths]
save('artifacts.json',{'files':files,'artifactCountWithoutReceipt':len(files),'receiptExcludesItself':True,'materialOnlyOutsideRepo':True,'productAttempts':0,'gitCommands':0})
print(json.dumps({'negativeProposal':True,'sourcePins':len(rows),'consideredSourceLines':manifest['semanticReadLineCountWithoutInstruction'],
                  'artifactsWithoutReceipt':len(files),'metadataFailures':1,'allFinishSourceHashesMatch':all(r['matchesFirstCaptured'] for r in finish),
                  'testsRun':0,'runtimeImports':0,'gitCommands':0},ensure_ascii=False))
