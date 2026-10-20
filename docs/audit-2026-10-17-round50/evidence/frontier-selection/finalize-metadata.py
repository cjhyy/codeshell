from pathlib import Path
import json,hashlib,datetime,re,subprocess,collections
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell'); OUT=Path('/tmp/codeshell-audit-round87-frontier-selection')
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b): return hashlib.sha256(b).hexdigest()
def save(n,x): (OUT/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
# Observed stderr only; no replay of the failed metadata presenter.
(OUT/'first-reader-stderr.txt').write_text('''Traceback (most recent call last):
  File "<stdin>", line 7, in <module>
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/json/__init__.py", line 242, in dumps
    **kw).encode(obj)
          ~~~~~~^^^^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/json/encoder.py", line 202, in encode
    chunks = self.iterencode(o, _one_shot=True)
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/json/encoder.py", line 263, in iterencode
    return _iterencode(o, 0)
TypeError: keys must be str, int, float, bool or None, not tuple
'''.replace('/Frameworks/Python.framework/Versions/3.14/json/encoder.py','/Frameworks/Python.framework/Versions/3.14/lib/python3.14/json/encoder.py'))
d=json.loads((OUT/'first-reader-diagnostic.json').read_text()); d['observedStderrTranscribedVerbatim']='first-reader-stderr.txt'; d['originalFullStdoutNotSeparatelyCaptured']='59 printed records remain in history-claims.json and tool chunk19aa79; do not call a regenerated file original raw stdout'; save('first-reader-diagnostic.json',d)
pins=json.loads((OUT/'candidate-initial-pins.json').read_text())['files']; claims=json.loads((OUT/'history-claims.json').read_text())['claims']; read=json.loads((OUT/'canonical-metadata-read.json').read_text())['rows']; hist=json.loads((OUT/'history-summary.json').read_text()); loc=json.loads((OUT/'history-locators.json').read_text()); inv=json.loads((OUT/'history-initial-inventory.json').read_text())['files']
prefix='packages/desktop/src/renderer/'
order=['extensions/pluginPresentation.ts','chat/ComposerSuggestions.tsx','settings/ParamControls.tsx','messages/GoalProgressView.tsx','messages/ContextBoundaryView.tsx','chat/ContextRing.tsx','messages/time.ts','messages/agentGroup.ts','app/panelResize.ts','settings/ThemePackPreview.tsx','settings/ShortcutsSection.tsx','components/ui/select.tsx','components/ui/dialog.tsx','chat/InlineMedia.tsx','chat/Lightbox.tsx','chat/MentionPopover.tsx','chat/useAnchoredPopover.ts','messages/AgentMessageView.tsx','builtin-character-themes.ts','topbar/liveActivity.ts','chat/compress.ts','app/appUtils.ts','chat/ModelPill.tsx','shell/CommandPalette.tsx','theme.ts','theme-packs.ts','components/ui/dropdown-menu.tsx','settings/SettingsMenu.tsx','settings/useSettingsNavigationFocus.ts','messages/StreamingMarkdown.tsx']
assert set(prefix+s for s in order)=={r['path'] for r in pins}
selected={'app/appUtils.ts','chat/ModelPill.tsx','shell/CommandPalette.tsx','theme.ts','theme-packs.ts'}
hashonly={'settings/ParamControls.tsx','settings/ShortcutsSection.tsx','settings/ThemePackPreview.tsx'}
rows=[]
for rank,n in enumerate(order,1):
 p=prefix+n; pin=next(r for r in pins if r['path']==p); rs=[r for r in read if r['path']==p]
 if n in selected:
  status='same-SHA-explicit-selected'; reason='Original selected qualifier/ranges retained; no full promotion.'
 elif n in hashonly:
  status='same-SHA-explicit-hash-only'; reason='Original canonical record explicitly hash-only; not evidence of semantic absence elsewhere.'
 elif n=='settings/SettingsMenu.tsx':
  status='ambiguous-over-EOF-selected-qualifier'; reason='R6 /sources/8 says selected1-300 against294 lines, navigation ownership only/account actions excluded. Do not silently clamp or promote to full.'
 elif n=='settings/useSettingsNavigationFocus.ts':
  status='ambiguous-bounded-full-qualifier'; reason='R6 /sources/7 literally full; static responsive navigation focus contract only. Preserve bounded qualifier; not activated as unrestricted old-full or global full.'
 elif n=='messages/StreamingMarkdown.tsx':
  status='old-full-different-SHA'; reason='R28 full1-173 binds0266a93f..., not current165-line SHA. No automatic current full; prior known cause/family still needs exclusion. Deferred.'
 elif n=='components/ui/dropdown-menu.tsx':
  status='old-hash-different-SHA'; reason='Legacy validation source inventory SHA6183840d... differs from current. Hash inventory is not semantic review.'
 else:
  status='semantic-scope-not-confirmed'; reason='No activated explicit same-SHA full/selected object for this path in this finite gate. This is not an unread claim; MD-only/other shapes not exhaustive.'
 pointers=[]
 for r in rs:
  if r['originalMetadataFields'] or r.get('additionalOriginalMetadataFields') or not r['sameCurrentSourceSha'] or '/evidence/' in r['document']:
   pointers.append({k:r[k] for k in ['document','documentSha256','jsonPointer','sameCurrentSourceSha','originalMetadataFields','additionalOriginalMetadataFields','ancestorScalarQualifiers']})
 machine=[c for c in claims if c['path']==p]
 rows.append({'rank':rank,'path':p,'bytes':pin['bytes'],'sha256':pin['sha256'],'lines':pin['lines'],'status':status,'decisionReason':reason,'activatedOldFull':False,'nextStep':'Suggestion only; own fresh exact path/SHA/full/old-cause MD+JSON gate before any future body read; confirm ordinary consumer and stop authority/native boundaries.','canonicalSupportPointers':pointers,'machineClaimCount':len(machine),'locatorCount':sum(x['path']==p for x in loc['locators']),'noCanonicalQualifiedRowProofOfUnread':False})
counts=dict(collections.Counter(r['status'] for r in rows))
save('candidates.json',{'finiteSelection':30,'rankingIsSemanticCoverageClaim':False,'globalCountsChanged':False,'counts':counts,'activatedSameShaUnrestrictedOldFull':0,'reviewModeCompleteAliasesActivated':0,'reviewModeRule':'Only prep78 two canonicalagent-definition rows are permitted aliases; neither is selected here. No generic complete/complete-in-scope/readMode alias activated.','files':rows})
# Ending checks repeat metadata hashes only, without reading any product text.
end=[]
for pin in pins:
 b=(ROOT/pin['path']).read_bytes(); end.append({'path':pin['path'],'bytes':len(b),'sha256':sha(b),'sameAsInitial':len(b)==pin['bytes'] and sha(b)==pin['sha256'],'checkedUTC':now()})
cmd=['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.MD','-g','*.json']; r=subprocess.run(cmd,cwd=ROOT,capture_output=True); assert r.returncode==0
allpaths=sorted(set(r.stdout.decode().splitlines())); current=[]; excluded=[]
for p in allpaths:
 m=re.match(r'^docs/audit-\d{4}-\d{2}-\d{2}-round(\d+)(?:/|$)',p)
 (excluded if m and int(m.group(1))>=50 else current).append(p)
initial={x['path']:x for x in inv}; changed=[]; missing=[]
for p,x in initial.items():
 if not (ROOT/p).is_file(): missing.append(p); continue
 b=(ROOT/p).read_bytes()
 if len(b)!=x['bytes'] or sha(b)!=x['sha256']: changed.append({'path':p,'initialBytes':x['bytes'],'endingBytes':len(b),'initialSha256':x['sha256'],'endingSha256':sha(b)})
inputchecks=[]
for x in json.loads((OUT/'selection-input-pins.json').read_text())['files']:
 b=(ROOT/x['path']).read_bytes(); inputchecks.append({'path':x['path'],'bytes':len(b),'sha256':sha(b),'sameAsInitial':len(b)==x['bytes'] and sha(b)==x['sha256']})
ending={'checkedUTC':now(),'products':end,'selectionMetadataInputs':inputchecks,'history':{'initialCount':len(inv),'endingIncludedPathCount':len(current),'sameIncludedPathSet':set(initial)==set(current),'changed':changed,'missing':missing,'addedIncludedPaths':sorted(set(current)-initial.keys()),'removedIncludedPaths':sorted(initial.keys()-set(current)),'excludedAudit50PlusPaths':excluded,'method':'Only metadata endingbyte/SHA/path inventory; original scan not overwritten or rerun.'}}
save('ending-checks.json',ending)
manifest={'root':str(ROOT),'rootContextCommitExternal':'7dcd41b9a1bfd23ecc6e6563fd8fbf569cf9483b','gitVerifiedByThisAuthor':False,'files':[{k:p[k] for k in ['path','bytes','sha256','lines','pinnedUTC']}|{'coverage':'hash-only','selectedLineRanges':[],'displayedLineRanges':[],'semanticLineCount':0,'displayedLineCount':0,'initialPinIsSemanticReadProof':False,'endingSha256':next(e['sha256'] for e in end if e['path']==p['path'])} for p in pins],'totals':{'productHashOnlyFiles':30,'productSourceBodiesDisplayed':0,'productSemanticFiles':0,'productSemanticLines':0,'productNavigationLines':0,'testDeclarationLines':0,'testsExecuted':0},'historicalMetadataReading':{'canonicalRows':59,'canonicalDocuments':23,'historicalProductCaptureBodiesDisplayedOrSemanticallyRead':0,'machineScannedRecursiveHistoricalStringsMayContainOldCaptures':True},'globalSemanticCoverageUpdate':False}
save('source-manifest.json',manifest)
checks={'checkedUTC':now(),'classification':{'formal':0,'candidate':0,'related':0,'meaning':'Metadata frontier selection only; not a product correctness or negative audit finding.'},'finiteCandidateCount':30,'statusCounts':counts,'currentProductSourceShaChecks':30,'allThirtySourcesMatchInitial':all(e['sameAsInitial'] for e in end),'allThirtyMatchOldInventory':all(p['matchesOldInventorySha'] for p in pins),'history':hist,'actualRead':{'productBodyLines':0,'testDeclarationLines':0,'canonicalOriginalMetadataRows':59,'canonicalOriginalMetadataDocuments':23,'historicalMDSourceBodyContexts':0,'all407ClaimsAreActualSemanticReads':False,'machineLocators':loc['count'],'machineLocatorCap':None,'canonicalRowsReviewed':59},'associations':{'directSameObjectUniquePathAndUniqueHashRequiredForActivation':True,'ancestorHashAssociationsActivated':0,'unrestrictedOldFullActivated':0,'completeAliasesActivated':0,'overEofRangeNormalized':False,'boundedFullPromoted':False,'oldIndexModified':False,'old49Or57ClassifierRun':False},'execution':{'product':0,'helper':0,'fixture':0,'test':0,'React':0,'UI':0,'browser':0,'native':0,'network':0,'Git':0,'authorFrozenMethods':0,'ownStdlibMetadataScripts':True},'metadataDiagnostics':[d],'metadataTruncations':0,'files':[],'metadataOnlySourceRowsIn':'source-manifest.json','ending':{'productsUnchanged':all(e['sameAsInitial'] for e in end),'selectionInputsUnchanged':all(e['sameAsInitial'] for e in inputchecks),'historyChangedCount':len(changed),'historyAddedIncludedCount':len(ending['history']['addedIncludedPaths']),'historyRemovedIncludedCount':len(ending['history']['removedIncludedPaths'])}}
save('checks.json',checks)
statusLabels={'same-SHA-explicit-selected':'selected','same-SHA-explicit-hash-only':'hash only','ambiguous-over-EOF-selected-qualifier':'ambiguous: over EOF','ambiguous-bounded-full-qualifier':'ambiguous: bounded full','old-full-different-SHA':'old full / different SHA','old-hash-different-SHA':'old hash / different SHA','semantic-scope-not-confirmed':'scope unconfirmed'}
report='''# Prep87 finite frontier selection\n\nThis packet selects30 ordinary Renderer UI/data candidates from dated coverage metadata. It performs no product semantic review and creates no formal/candidate/related finding. The Root-supplied context is7dcd41b9a1bfd23ecc6e6563fd8fbf569cf9483b; this author ran no Git. All30 paths remain100–500lines and match the old inventory and their own before/ending SHA.\n\nThe fresh history inventory includes frozen audit49 and earlier, excludes audit directory rounds50+, and scans all docs/bugs Markdown plus recursive JSON scalar values, including archives. It contains4693 files:1457MD/3236JSON,2129441string values/3168045scalar values. Exact directory component `archive` matches162files; substring `archive` matches174. These are separate explicitly defined algorithms, not interchangeable archive totals. No50+ directory file was present at the initial inventory.\n\nThe machine retained407 direct-object claim locators, of which59 have a manifest filename hint. I read the original59 row metadata and scalar ancestor limitations across23 canonical documents. This is not407 semantic reads. Keys are not searched as value text; no historical source capture was displayed or semantically read. Machine locator cap is unlimited and all retained locator counts are preserved. The dated input summary/adapter methods were not executed.\n\nNo unrestricted same-SHA old-full rule is activated in this finite set. Five paths have original selected qualifiers, three explicit hash-only, two have ambiguous qualifiers, one has an old full tied to a different SHA, one old hash tied to a different SHA, and18have no activated semantic scope confirmation. A missing or unrecognized row never means unread. MD-only full evidence and arbitrary historical schemas are not exhausted; every future source task still needs its own exact path/SHA/full/old-cause gate before body reading.\n\nThe R6 `useSettingsNavigationFocus` row literally says `full; static responsive navigation focus contract only`; preserve that bounded evidence rather than converting it into unrestricted complete coverage. R6 `SettingsMenu` says selected1–300 against294lines and excludes account/actions: the over-EOF range remains ambiguous and is not silently clamped. R28 `StreamingMarkdown` full1–173 binds an old SHA, not the current165-line file. Historical hash inventories, incidentals, navigation and transitive source bindings never become semantic review. Generic `reviewMode=complete` is not activated; only the two prep78-proven canonical aliases are eligible, and neither path is in this selection.\n\nThe ordering below is a metadata suggestion based on ordinary UI/data file names, not proof of a currently reachable producer/consumer contract or absence of prior bugs. Known selected/bounded/stale areas are deferred. Any future review stops at native, authority, credential, custody or identity mechanisms; it does not reopen failed dynamic directions. No current product text was decoded/displayed, no test declarations were read, and no product/helper/fixture/test/UI/native/network operation ran. Own Python stdlib metadata/hash scripts and `rg --files` were the only execution.\n\n| Rank | Candidate (Renderer-relative) | Lines | Metadata status |\n| --- | --- | ---: | --- |\n'''
for row in rows: report+=f"| {row['rank']} | `{row['path'][len(prefix):]}` | {row['lines']} | {statusLabels[row['status']]} |\n"
report+='''\nExact SHA, original document SHA/JSON pointer, qualifiers, ancestor limitations and per-path hit counts are in [candidates](candidates.json) and [original metadata reading](canonical-metadata-read.json). This does not change global coverage counts or any old index.\n\nThe first metadata presenter printed all59 rows then failed only while serializing a final tuple-key Counter summary (`TypeError`, exit1). The [first script](first-reader.py), [diagnostic](first-reader-diagnostic.json) and [observed stderr](first-reader-stderr.txt) preserve that event. No product operation failed or was retried. A bounded JSON-friendly metadata presentation continued from the saved claims; the history scan was not repeated.\n\n[Source manifest](source-manifest.json), [checks](checks.json), [initial source pins](candidate-initial-pins.json), [history summary](history-summary.json), [history inventory](history-initial-inventory.json), [claim locators](history-claims.json), [ending checks](ending-checks.json), and [artifact receipt](artifact-receipt.json) preserve scope and timing. Ending differences, if any, remain dated in ending-checks and do not rewrite initial evidence.\n'''
(OUT/'report.md').write_text(report)
# Validate only this new packet's local links, and ending metadata invariants.
links=re.findall(r'\[[^\]]*\]\(([^)]+)\)',report); bad=[]
for link in links:
 if not (OUT/link).is_file() and link!='artifact-receipt.json': bad.append(link)
assert not bad,bad
checks['localReportLinks']={'count':len(links),'allValidExceptReceiptCreatedNext':True,'bad':bad}
save('checks.json',checks)
print(json.dumps({'candidateCount':len(rows),'statusCounts':counts,'canonicalRows':59,'currentSourcesAllUnchanged':checks['allThirtySourcesMatchInitial'],'endingHistory':checks['ending'],'localLinks':len(links),'currentPacketFileCountBeforeReceipt':len(list(OUT.iterdir()))},ensure_ascii=False))
