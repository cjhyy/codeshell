#!/usr/bin/env python3
"""Metadata assembly only. Never runs or repairs a product fixture."""
import hashlib,json,pathlib,re,subprocess
root=pathlib.Path(__file__).resolve().parents[3]
evidence=pathlib.Path(__file__).parent
batch=evidence.parent
frozen='7927a7c8b80b4aec710dee1f6d831ad1982bb466'
def sha(data):return hashlib.sha256(data).hexdigest()
def save(name,obj):(evidence/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
sources=[
'CODESHELL.md',
'scripts/run-bun-test-shard.mjs',
'packages/desktop/src/renderer/messages/streamGroups.ts',
'packages/desktop/src/renderer/messages/streamGroups.test.ts',
'packages/desktop/src/renderer/messages/agentGroup.ts',
'packages/desktop/src/renderer/messages/agentGroup.test.ts',
'packages/desktop/src/renderer/messages/AgentGroupCard.tsx',
'packages/desktop/src/renderer/messages/fileChangeAggregator.ts',
'packages/desktop/src/renderer/messages/fileChangeAggregator.test.ts',
'packages/desktop/src/renderer/messages/fileChangeAggregator.count.test.ts',
'packages/desktop/src/renderer/messages/FilesChangedCard.tsx',
'packages/desktop/src/renderer/messages/time.ts',
'packages/desktop/src/renderer/messages/time.test.ts',
'packages/desktop/src/renderer/messages/turnTiming.test.ts',
'packages/desktop/src/renderer/MessageStream.tsx',
'packages/desktop/src/renderer/types.ts',
'packages/desktop/src/renderer/diff/parseUnifiedDiff.ts',
'packages/coding/src/tools/apply-patch/index.ts',
'packages/coding/src/tools/apply-patch/parser.ts',
'packages/coding/src/tools/apply-patch/types.ts',
'docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md',
'docs/superpowers/specs/2026-06-07-agent-summary-view-design.md',
]
manifest=[]
for name in sources:
 blob=subprocess.run(['git','show',frozen+':'+name],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stdout
 current=(root/name).read_bytes()
 manifest.append({'path':name,'frozenSha256':sha(blob),'sha256':sha(current),'frozenBytes':len(blob),'currentEqualsFrozen':current==blob})
assert all(f['currentEqualsFrozen'] for f in manifest)
save('groups-source-manifest.json',{'frozenSource':frozen,'files':manifest,'scope':'Inspected selected source and baseline runtime inputs. Pins do not imply full-file behavioural coverage; source-only versus executed scope is in groups.md.'})
common={'sourceBase':frozen,'evidenceLevel':'Source-only candidate; focused first fixture failed before tests loaded; whole focused direction skipped without repair or alternative validation','report':str((batch/'groups.md').relative_to(root)),'limits':'No production ApplyPatch, UI/React/native/Git product process/model/network/user-data execution. No actual summary result observed for candidate cases.'}
candidates=[
{**common,'id':'GROUPS-R13-C1','title':'合法 header-only Delete 补丁可能不生成 Desktop 文件摘要','file':'packages/desktop/src/renderer/messages/fileChangeAggregator.ts','line':95,'relatedSources':['packages/coding/src/tools/apply-patch/parser.ts:127','packages/coding/src/tools/apply-patch/index.ts:42','packages/desktop/src/renderer/types.ts:1897'],'reason':'Delete header initializes zero added/removed; flush requires nonzero content line counts, so source predicts a missing changed-file entry. Exact deleted line counts are not required by this candidate.'},
{**common,'id':'GROUPS-R13-C2','title':'合法 V4A ++/-- 内容可能被当作 unified diff header 排除','file':'packages/desktop/src/renderer/messages/fileChangeAggregator.ts','line':137,'relatedSources':['packages/coding/src/tools/apply-patch/parser.ts:14'],'reason':'V4A marker plus ++counter;/--counter; yields +++counter;/---counter;, but Desktop parser excludes those prefixes, predicting missing entries or one-sided counts/synthetic diff.'},
]
save('groups-candidates.json',{'sourceBase':frozen,'candidates':candidates})
save('groups-findings.json',{'sourceBase':frozen,'findings':[],'reason':'Focused fixture failed at source import. Candidates remain source-only; passing existing baseline is not substituted as proof.'})
save('groups-related.json',{'sourceBase':frozen,'relatedObservations':[{'id':'GROUPS-R13-R1','title':'Desktop Move marker flush branch related to prior external changedFiles rename family','file':'packages/desktop/src/renderer/messages/fileChangeAggregator.ts','line':132,'history':'docs/audit-2026-10-17/root.md R2-08','evidenceLevel':'Source-only; focused fixture skipped after initial import failure','countedConfirmed':False,'countedCandidate':False,'limits':'Separate parser implementation but related visible rename family; no runtime observation.'}]})
runs=[]
for label in ['groups-existing-baseline','groups-patch-summary']:
 receipt=evidence/(label+'.first.exit.json');r=json.loads(receipt.read_text());raw=evidence/(label+'.first.raw.log');b=raw.read_bytes();text=b.decode()
 assert sha(b)==r['rawSha256'] and len(b)==r['rawBytes']
 completed='Completed Bun shard:' in text
 clean=r['exitCode']==0 and completed and re.search(r'\b0 fail\b',text) is not None
 passed=int(re.search(r'^\s*(\d+) pass$',text,re.M).group(1))
 failures=int(re.search(r'^\s*(\d+) fail$',text,re.M).group(1))
 expect=re.search(r'^\s*(\d+) expect\(\) calls$',text,re.M)
 errors=re.search(r'^\s*(\d+) error$',text,re.M)
 run={**r,'name':label,'attempt':1,'sourceBase':frozen,'rawCombinedStdoutStderr':str(raw.relative_to(root)),'rawLogSha256':sha(b),'exitFile':str(receipt.relative_to(root)),'exitFileSha256':sha(receipt.read_bytes()),'passedTests':passed,'tests':passed if clean else 0,'expectCalls':int(expect.group(1)) if expect else 0,'failures':failures,'errors':int(errors.group(1)) if errors else 0,'skipped':0,'guardedCompletionPresent':completed,'clean':clean,'kind':'existing pure baseline' if clean else 'focused fixture load failure; whole direction SKIP','plannedFocusedTests':0 if clean else 7,'focusedTestBodiesExecuted':0}
 runs.append(run)
assert runs[0]['clean'] and runs[0]['passedTests']==33 and runs[0]['expectCalls']==66
assert not runs[1]['clean'] and runs[1]['passedTests']==0 and runs[1]['failures']==1 and runs[1]['errors']==1
save('groups-validation.json',{'sourceBase':frozen,'confirmedFindings':[],'candidateIds':[c['id'] for c in candidates],'relatedObservationsNotCounted':['GROUPS-R13-R1'],'runs':runs,'totals':{'cleanFirstShards':1,'tests':33,'expectCalls':66,'baselineTests':33,'newFocusedTests':0,'cleanFailures':0,'skipped':0,'failedShards':1,'failedShardPassedTests':0,'failedShardFailures':1,'failedShardErrors':1,'retries':0},'firstRunPolicy':'All first combined output bytes and exit saved before inspection. Wrong relative fixture import caused load failure; preserve and SKIP entire focused direction, no repair/rerun/alternate validation. Passing existing baseline not used as substitute.','scope':'Pure existing aggregateFileChangeSummary/countLines/agentGroup and baseline parseUnifiedDiff only. All new candidate producer/consumer claims source-only. streamGroups/time/turnTiming not executed. No new external dependency.','sourceManifest':str((evidence/'groups-source-manifest.json').relative_to(root)),'dedup':[str((evidence/'groups-dedup.json').relative_to(root)),str((evidence/'groups-patch-dedup.json').relative_to(root))],'skipNote':str((evidence/'groups-skip-note.md').relative_to(root))})
artifacts=[]
for path in sorted([batch/'groups.md',*evidence.glob('groups-*')]):
 if not path.is_file() or path.name=='groups-artifact-receipt.json':continue
 b=path.read_bytes();artifacts.append({'path':str(path.relative_to(root)),'bytes':len(b),'sha256':sha(b)})
save('groups-artifact-receipt.json',{'sourceBase':frozen,'artifacts':artifacts,'selfExcluded':True,'policy':'Metadata only; no product test or failed fixture rerun.'})
print(json.dumps({'sources':len(manifest),'artifacts':len(artifacts),'confirmed':0,'candidates':len(candidates),'cleanTests':33,'cleanExpectCalls':66,'failedFirstShards':1,'retries':0}))
