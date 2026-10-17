from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round132-topic-segment')
P='packages/pet/src/';D='packages/desktop/src/main/pet/';C='packages/core/src/'
def sha(b):return hashlib.sha256(b).hexdigest()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def walk(x):
 yield x
 if isinstance(x,dict):
  for v in x.values():yield from walk(v)
 elif isinstance(x,list):
  for v in x:yield from walk(v)
def flat(rs):return {i for a,z in rs for i in range(a,z+1)}
def merge(ns):
 out=[]
 for n in sorted(set(ns)):
  if out and n==out[-1][1]+1:out[-1][1]=n
  else:out.append([n,n])
 return out
# Reuse exact source pins and actual display/navigation metadata, not a new source semantic read.
pins={};disp={};nav={}
for f in sorted(O.glob('*.json')):
 x=json.loads(f.read_text())
 for v in walk(x):
  if not isinstance(v,dict):continue
  p=v.get('path')
  if isinstance(p,str) and (p.startswith('packages/') or p in ['CODESHELL.md','AGENTS.md']) and 'pinAt' in v and 'sha256' in v and 'bytes' in v:
   if p not in pins or v['pinAt']<pins[p]['pinAt']:pins[p]=v
  if isinstance(p,str) and p.startswith('packages/') and isinstance(v.get('displayedLineRanges'),list):disp.setdefault(p,set()).update(flat(v['displayedLineRanges']))
  cmd=v.get('command')
  if isinstance(cmd,list) and cmd[:2]==['rg','-n'] and cmd[-1].startswith('packages/') and isinstance(v.get('stdout'),str):
   for s in v['stdout'].splitlines():
    m=re.match(r'(\d+):',s)
    if m:nav.setdefault(cmd[-1],set()).add(int(m.group(1)))
S={
P+'topic-segment.ts':('full',[[1,75]],'product','Pure topic contract/threshold/carryover/memory primitive, all75 read; known prior same-SHA full R10 /files/0 and earlierMD retained.'),
P+'segment-closure.ts':('full',[[1,154]],'product','Pure boundary locator/parser/prompt data primitives, all154 read; known prior full MD and supplemental same-SHA R10 /files/1 checked after current read, not retroactive pre-body timing.'),
P+'conversation-session-route.ts':('full',[[1,369]],'product','Complete local notify/bound/create/parse/enter/leave/suspend/inbound/expiry/stale state functions. No authority conclusion from this DTO/domain module alone.'),
D+'pet-segment-controller.ts':('selected',[[10,51],[53,105],[108,275]],'product','Actual serialized beginTurn/manual clear, prior/new boundaries, carryover and close sink; no models/timers invoked.'),
D+'conversation-session-route-store.ts':('selected',[[27,245],[248,256],[278,305]],'product','Actual staged serialized route state transitions, expiry and notification selection. Neighboring bounded JSON/FS quarantine implementation not certified; helper not imported.'),
D+'pet-segment-closure-service.ts':('selected',[[1,15],[38,51],[60,111],[135,302]],'product','Actual transcript filter, window→null early return, journal/memory source effects, backfill and read projection. Secret-redaction and settings/SDK native/client mechanism adjacency excluded; no actual user transcript/client call.'),
D+'session-conversation-bridge.ts':('selected',[[96,178]],'product','Actual route caller expiry→bound state, explicit leave/status, direct-message/health gates, confirmed delivery then inbound stamp. External health/authorization implementation not fully traversed or certified.'),
D+'pet-dispatch-service.ts':('selected',[[1051,1075],[1078,1093],[1178,1202],[1991,2020],[2185,2223],[2338,2348],[2372,2398]],'product','Real accepted follow-up manager admission→chat fixedID→unconditional topic beginTurn→injected worker params→post-settle closure. Other world/host/permission branches displayed incidentally, no whole dispatcher or permission certification.'),
'packages/desktop/src/main/index.ts':('selected',[[2163,2181],[2211,2231],[2600,2638]],'product','Production follow-up runtime/dispatch/controller wiring, default12h and closure/backfill sink. No whole main or native startup execution.'),
C+'engine/run-session-open.ts':('selected',[[140,142],[175,181],[211,218]],'product','Actual resumed/new user message producer carries injected and clientMessageId to Transcript; other open/dedup/ownership state adjacency excluded.'),
D+'pet-follow-up-runtime.ts':('selected',[[17,45],[46,104],[105,129]],'product','Actual due resume eligibility and dispatch.wakeFollowUp branch; valid idle source without taskId is allowed. Selected continuation guards are source only, no universal authorization certification.'),
C+'session/transcript.ts':('selected',[[528,543],[550,570]],'product','Documented synthetic-user metadata and exact message.data injected/clientMessageId producer; no disk IO executed or all transcript folding branches assessed.'),
P+'follow-ups.ts':('selected',[[79,128]],'product','Real explicit future wake-at/resume tool contract. Contract admits intent but is not treated as Host permission enforcement.'),
P+'registered-follow-ups.ts':('selected',[[129,163]],'product','Shared payload validation normal future-time field shape; no authorization defect alleged.'),
D+'pet-follow-up-wake-coordinator.ts':('selected',[[90,130],[145,173]],'product','Actual one-shot runAt=wakeAt scheduling, claim→resume selection; no clock/scheduler/claim/notification execution or custody/lease certification.'),
C+'protocol/server.ts':('selected',[[1809,1821],[1987,1999]],'product','Actual session/legacy run forwarding of injected and clientMessageId, not overall protocol authorization review.'),
C+'protocol/chat-session.ts':('selected',[[516,527]],'product','Normal queue→Engine forwarding same injected/client ID/archive option; adjacent permission fields not certified.'),
C+'protocol/dispatch.ts':('selected',[[111,113]],'product','Actual injected boolean validation only; no other dispatch policy conclusions.'),
D+'pet-registered-follow-up-store.ts':('selected',[[272,305]],'product','Actual registration admission validates ordinary payload then requires wakeAt>now, with no <12h upper bound in selected admitted branch; no user file or mutation operation executed.'),
D+'pet-work-memory-store.ts':('selected',[[93,119],[143,153],[156,160],[179,188]],'product','Actual active/all/boundary segments and whole segment object staged/persist snapshot; normal boundary retained. Physical IO/owner security not certified.'),
P+'topic-segment.test.ts':('selected',[[7,14]],'test-declaration','Two existing idle threshold declarations, read only, never executed.'),
P+'segment-closure.test.ts':('selected',[[19,46]],'test-declaration','Existing exact boundary and absent-ID→null declarations, read only, never executed.'),
P+'conversation-session-route.test.ts':('selected',[[83,120]],'test-declaration','Existing enter/leave/suspend state declarations, read only, never executed.')}
rows=[]
for p,(cov,rs,kind,purpose) in S.items():
 f=pins[p];b=(R/p).read_bytes();lines=len(b.splitlines());assert all(1<=a<=z<=lines for a,z in rs);assert flat(rs)<=disp.get(p,set()),(p,flat(rs)-disp.get(p,set()))
 rows.append({'path':p,'bytes':len(b),'lines':lines,'sha256':sha(b),'coverage':cov,'selectedLineRanges':rs,'displayedLineRanges':merge(disp.get(p,set())),'navigationLineRanges':merge(nav.get(p,set())),'sourceKind':kind,'semanticLineCount':len(flat(rs)),'uniqueBodyDisplayedLines':len(disp.get(p,set())),'scope':purpose,'initialPinAt':f['pinAt'],'initialSemanticReadSha256':f['sha256'],'endingSha256':sha(b),'endingMatchesInitial':sha(b)==f['sha256']})
navOnly=[]
for p,f in pins.items():
 if p.startswith('packages/') and p not in S:navOnly.append({'path':p,'bytes':f['bytes'],'sha256':f['sha256'],'lines':f['lines'],'coverage':'navigation-matches-only' if nav.get(p) else 'hash-only','selectedLineRanges':[],'navigationLineRanges':merge(nav.get(p,set())),'semanticLineCount':0,'scope':'No body semantic read; engine/assistant field-location navigation was not a complete branch review.'})
prod=sum(v['semanticLineCount'] for v in rows if v['sourceKind']=='product');tests=sum(v['semanticLineCount'] for v in rows if v['sourceKind']=='test-declaration');body=sum(v['uniqueBodyDisplayedLines'] for v in rows);extras=sum(len(nav.get(p,set())-disp.get(p,set())) for p in pins if p.startswith('packages/'))
manifest={'prep':132,'root':str(R),'rootReportedBaseline':'1ba606416f4fc94c081159bb3fd10e58cd8d87f0','GitVerified':False,'files':rows,'navigationOrHashOnlyFiles':navOnly,'instructionHashOnlyFiles':[{'path':p,'bytes':pins[p]['bytes'],'sha256':pins[p]['sha256'],'coverage':'hash-only same as prior actually read instructions','newInstructionReadLines':0} for p in ['CODESHELL.md','AGENTS.md']],'totals':{'fullProductFiles':sum(x['coverage']=='full' and x['sourceKind']=='product' for x in rows),'selectedProductFiles':sum(x['coverage']=='selected' and x['sourceKind']=='product' for x in rows),'selectedTestDeclarationFiles':3,'productSemanticLines':prod,'testDeclarationLines':tests,'allSemanticDeclarationLines':prod+tests,'sourceBodyDisplayedLines':body,'navigationBeyondBodyLines':extras,'allDisplayedSourceLinesIncludingNavigation':body+extras,'testRuns':0},'overlap':'Topic75 and closure154 explicitly old full in canonical MD, same SHA manifest rows retained. Other mechanism prior coverage not claimed absent. Counts are this read, not unique new/global coverage. Full local file reading does not certify transitive authorization, persistence or runtime behavior.'};save('source-manifest.json',manifest)
# Exact causal excerpts copied only from already displayed selected ranges.
causal={D+'pet-dispatch-service.ts':[[1178,1188],[2217,2223],[2345,2348],[2372,2395]],D+'pet-segment-controller.ts':[[191,205],[219,245]],D+'pet-segment-closure-service.ts':[[78,91],[195,208],[249,275]],P+'segment-closure.ts':[[61,75]],C+'session/transcript.ts':[[562,567]],D+'pet-registered-follow-up-store.ts':[[289,305]],D+'pet-work-memory-store.ts':[[143,153],[179,188]]}
ce=[]
for p,rs in causal.items():
 b=(R/p).read_bytes();ls=b.decode().splitlines();ce.append({'path':p,'sourceSha256':sha(b),'note':'Copied after actual display, not a new semantic read or pre-read snapshot','ranges':[{'start':a,'end':z,'text':'\n'.join(ls[a-1:z])+'\n','textSha256':sha(('\n'.join(ls[a-1:z])+'\n').encode())} for a,z in rs]})
save('candidate-evidence.json',ce)
proposal={'id':'PET-R132-C1','classification':'candidate','proposedPriority':'P3','title':'定时续办唤醒成为被收尾reader过滤的话题边界，跳过自动小结和记忆提取','location':{'path':D+'pet-dispatch-service.ts','line':2218},'normalConditions':['Pet active base/previous segment has ordinary meaningful user/assistant messages; auto-extraction enabled.','A user-authorized accepted resume follow-up, with a valid idle native source and no pending decision, is due after at least the configured12h idle gap; no taskId short-circuiting into paused-task resume is needed.','wakeFollowUp runs normally with its generated pet-followup-ID-revision clientMessageId; normal healthy worker run completes.'],'cause':['wakeFollowUp creates type chat and generated ID. Shared chat branch begins topic with thatID even for hostWake; controller opens new segment with boundaryBeforeMessageId=ID and closes previous with nextBoundary=ID.','Same worker run marks user injected:true and persists exactID plus injected into message.data.','Closure transcript reader deliberately skips injected user messages; exact boundary locator cannot find thisID and returns null, close immediately returns null before journal/generate/memory.','Backfill reuses stored segment boundaries and same reader/locator; it supplies no fallback for this missing boundary.'],'ordinaryImpact':'At least the just-closed topic receives no automatic journal extraction/auto-memory under these conditions; a later closure whose start is this stored synthetic boundary has the same missing-start condition.','counterevidenceAndLimits':['The independent Core span/context archival path is distinct; do not infer archive failure, raw message deletion, UI frames, cross-account routing or permission bypass.','Old plan explicitly discusses injected skipping versus span archival; retain it as related design boundary, not an exact already-reported journal/followup cause.','notify-only reminders do not go through resume dispatcher. Paused-task direct-control and unavailable/active/pending sources may return early; they are outside this normal accepted branch.','Manual clear/new user paths are not alleged broken. Without enabled extraction or sufficient content there is no same journal promise to lose.','Only static source reasoning, no runtime reproduction; whole assistant/transcript nonstandard writer branches and all dispatch policy paths not exhaustively verified.'],'formalCount':0,'candidateCount':1,'newRelatedCount':0,'normalFutureScheduleEvidence':[D+'pet-registered-follow-up-store.ts:272-305',D+'pet-follow-up-wake-coordinator.ts:123-129,145-173',P+'follow-ups.ts:79-128'],'dedup':'Shared5676 path/SHA count43 is navigation only; own two focused query sets in matched old MD/JSON found14 and32 scalar windows (caps35/60),10 explicitly read bounded windows. No exact prior follow-up→topic boundary→closure null cause established in those windows, not a full-history semantic absence claim.'}
save('classification.json',{'counts':{'formal':0,'candidate':1,'newRelated':0},'formal':[],'candidates':[proposal],'newRelated':[],'otherScope':'notify/bound state and actual Host route caller reviewed with finite negative result; no universal authorization/identity conclusion from DTO/domain logic.'})
sourcechecks=[]
for p,f in pins.items():
 b=(R/p).read_bytes();sourcechecks.append({'path':p,'initialSha256':f['sha256'],'endingSha256':sha(b),'bytes':len(b),'same':sha(b)==f['sha256']})
hist={}
for n in ['prior-canonical-objects.json','prior-md-selected.json','prior-closure-canonical.json','focused-oldcause-contexts.json','focused-oldcause-second-contexts.json']:
 x=json.loads((O/n).read_text())
 for v in walk(x):
  p=v.get('path') if isinstance(v,dict) else None
  if isinstance(p,str) and p.startswith(('docs/','bugs/')) and 'sha256' in v:hist[p]=v['sha256']
hchecks=[]
for p,h in hist.items():
 b=(R/p).read_bytes();hchecks.append({'path':p,'initialSha256':h,'endingSha256':sha(b),'same':sha(b)==h})
shared=json.loads((O/'shared-history-projection.json').read_text());i=shared['input'];b=Path(i['path']).read_bytes();sc={'path':i['path'],'initialSha256':i['sha256'],'endingSha256':sha(b),'same':sha(b)==i['sha256'],'scope':'Input JSON hash only, Root owns5676 inventory ending; no independent full rerun.'};assert all(x['same'] for x in sourcechecks+hchecks);assert sc['same'];save('ending-checks.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceChecks':sourcechecks,'priorAndFocusedHistoryChecks':hchecks,'sharedInputCheck':sc,'scope':'Hash-only ending; no repeated source semantic read or full-history rescan.'})
save('diagnostics.json',{'fatalMetadataErrors':0,'toolOutputTruncations':0,'navigationNoMatch':[{'artifact':'guard-test-navigation.json','query':'wakeFollowUp|pet-followup in main/index.ts','exitCode':1,'meaning':'No matching spelling in main; actual factory composition located by createPetFollowUpRuntime in same already-pinned source. Not product failure or runtime retry.'}],'firstFocusedLocator':{'filesReturned':14,'MDJSONActuallyParsed':12,'otherExtensions':'One .test.ts and one.log filename matched rg locator only, never opened/executed as source evidence; later scan explicitly admitted MD/JSON recursive values only.'},'rawOutputs':'Persisted rg commands/stdout/stderr/exits retained; no fabricated missing raw test log or execution. First outer command outputs are tool records only.','productFailures':0})
save('validation.json',{'productImports':0,'productHelperCalls':0,'fixtures':0,'testsRun':0,'realUserSessionsOrTraceData':0,'clockTimerExperiments':0,'ReactDOM':0,'nativeModelProductProcesses':0,'network':0,'GitCalls':0,'auditTools':['Python standard library metadata/hash/JSON/ranges','rg filename and exact source line navigation'],'sourceCounts':manifest['totals'],'endingSourcePins':len(sourcechecks),'endingHistoryDocs':len(hchecks),'endingAllPinsSame':True,'history':'Shared5676 incl56/ex57+,4212456 value scalar machine visits,topic43hits all saved; no author whole-history rescan. Own focused12/16matched MD/JSON subset and10bounded actual windows, not semantic exhaustion.','classification':'0 formal /1 candidate PET-R132-C1 P3 static proposal /0 new-related; independent review pending, not automatically promoted.'})
print(json.dumps({'sourceTotals':manifest['totals'],'files':len(rows),'navOnly':len(navOnly),'sourcePins':len(sourcechecks),'historyDocs':len(hchecks)}))

# Final candidate timeline clarification, metadata only.
x=json.loads((O/"classification.json").read_text())
x["candidates"][0]['normalTimeline']=[{'step': 'T0', 'state': 'S0 is current active segment, has at least3 ordinary meaningful user/assistant messages, has not closed or produced its own journal yet; lastInteractionAt=T0. Earlier already-recorded segments are unaffected.'}, {'step': 'T1>=T0+12h', 'state': 'An accepted registered resume follow-up generates H. beginTurn closes S0 with endH and opens S1 with startH; normal run persists userH injected:true. Immediately after run settles, closureS0 filters outH, cannot find endH, returnsnull before extraction.'}, {'step': 'BetweenT1andT2', 'state': 'A user turn before another idle gap leaves S1 active; it does not erase or repair H boundary.'}, {'step': 'T2>=lastInteractionAt+12h', 'state': 'A normal userU opens S2 and closes S1(startH,endU); reader lacks startH so S1 also returnsnull. S2 and later segments with real user anchors may work normally.'}]
x["candidates"][0]['shutdownBoundary']='Not read or alleged: this package does not claim shutdown actively closes a segment. ManualClear plus next real turn can also close one, but the core normal timeline uses two ordinary idle crossings.'
x["candidates"][0]['earlierPendingBoundary']='No earlier pending closure runtime result assumed. Existing correctly anchored or already-recorded segments can succeed/remain recorded; that does not make the H-anchored segment locatable.'
save("classification.json",x)
