from pathlib import Path
import json,re,hashlib,collections,datetime,subprocess
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round162-user-status')
def sh(b):return hashlib.sha256(b).hexdigest()
def save(n,d):(O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
cat=json.loads((R/'docs/audit-2026-10-17-round58/recorded-findings-catalog.json').read_text());arr=cat['findings'];md=(R/'docs/audit-2026-10-17-round58/ALL-ISSUES.md').read_text();rows=[]
for line in md.splitlines():
 m=re.match(r'^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(P[0-3])\s*\|\s*(.*?)\s*\|\s*$',line)
 if m:rows.append({'id':m[1],'canonicalLink':m[2],'priority':m[3],'title':m[4].replace('\\|','|')})
def clean(t):return re.sub(r'^\[P[0-3]\]\s*','',t).strip()
bymd={r['id']:r for r in rows};mismatch=[];records=[]
for x in arr:
 y=bymd.get(x['id']);record={k:x.get(k) for k in ['id','priority','title','sourceRound','canonicalFindings']};records.append(record)
 if y is None:mismatch.append({'id':x['id'],'reason':'missing-MD-row'});continue
 target=y['canonicalLink'];tail=target[target.find('/docs/')+1:] if '/docs/' in target else target
 if x['priority']!=y['priority'] or clean(x['title'])!=y['title'] or x['canonicalFindings']!=tail:mismatch.append({'id':x['id'],'catalog':record,'MD':y,'normalizedTarget':tail})
ids=[x['id'] for x in arr];counts=dict(collections.Counter(x['priority'] for x in arr));save('all118-historical-findings.json',{'scope':'Formal58 recorded historical findings, not current-unfixed or fresh-cause count; no formal61 proposal inserted','records':records,'count':len(records),'uniqueIDs':len(set(ids)),'priorities':counts})
text=['118条正式历史记录（不是当前未修数；按原catalog顺序）','字段：ID | 级别 | 历史标题 | 来源批次 | canonical原件','']
for x in records:text.append(f"{x['id']} | {x['priority']} | {clean(x['title'])} | R{x['sourceRound']} | {x['canonicalFindings']}")
(O/'all118-historical-findings.txt').write_text('\n'.join(text)+'\n')
base=json.loads(Path('/tmp/codeshell-audit-round154-coverage-migration/unified-current-index.json').read_text());basepaths={x['path'] for x in base['files']};coverage=dict(collections.Counter(x['publishableCurrentCoverage'] for x in base['files']));cmd=['rg','--files','-g','*.ts','-g','*.tsx'];start=datetime.datetime.now(datetime.timezone.utc).isoformat();r=subprocess.run(cmd,cwd=R,capture_output=True);(O/'inventory-first.stdout').write_bytes(r.stdout);(O/'inventory-first.stderr').write_bytes(r.stderr);save('inventory-first-exit.json',{'atUTC':start,'argv':cmd,'cwd':str(R),'exitCode':r.returncode,'stdoutBytes':len(r.stdout),'stdoutSha256':sh(r.stdout),'stderrBytes':len(r.stderr),'stderrSha256':sh(r.stderr),'scope':'Filename inventory only, no source bytes/body/import/test/Git.'});now=r.stdout.decode().splitlines();nowset=set(now);diff={'originalDenominator':len(basepaths),'currentFilenameInventory':len(now),'uniqueCurrentNames':len(nowset),'addedNames':sorted(nowset-basepaths),'removedNames':sorted(basepaths-nowset),'commandExit':r.returncode,'coverage':coverage,'notFullInOriginalDenominator':coverage['selected']+coverage['unknown'],'currentAddedEvidenceNotProductFull':'Do not add the extra audit evidence fixture to original product coverage denominator.'};save('coverage-status.json',diff);save('current-ts-filename-inventory.json',{'argv':cmd,'filenames':now,'productSourceSemanticRead':0})
pins=json.loads((O/'candidate-input-pins.json').read_text())['formalRootCandidateFiles'];occ=[];countchecks=[];extraCollections=[]
for p in pins:
 d=json.loads((R/p['path']).read_text());a=d if isinstance(d,list) else d.get('candidates',[])
 if not isinstance(a,list):raise TypeError('unsupported candidates list: '+p['path'])
 countchecks.append({'sourceRound':p['sourceRound'],'path':p['path'],'declaredCount':d.get('count') if isinstance(d,dict) else None,'actualCandidates':len(a),'declaredCountMatches':not isinstance(d,dict) or 'count' not in d or d['count']==len(a)})
 if isinstance(d,dict):
  for k,v in d.items():
   if k!='candidates' and isinstance(v,list) and v:extraCollections.append({'sourceRound':p['sourceRound'],'path':p['path'],'field':k,'count':len(v),'originalValues':v,'note':'Supplemental static observations/promoted alias metadata; not automatically candidate records or merged IDs.'})
 for i,x in enumerate(a):
  if not isinstance(x,dict):raise TypeError('candidate not object: '+p['path'])
  display=x.get('title') or x.get('summary') or x.get('hypothesis');occ.append({'sourceRound':p['sourceRound'],'canonicalFile':p['path'],'pointer':('/'+str(i)) if isinstance(d,list) else '/candidates/'+str(i),'id':x.get('id'),'title':x.get('title'),'status':x.get('status'),'summary':x.get('summary'),'hypothesis':x.get('hypothesis'),'displayTextOriginalField':display,'originalObject':x})
groups={};without=[]
for x in occ:
 if x['id'] is None:without.append(x);continue
 key=json.dumps(x['id'],ensure_ascii=False,sort_keys=True);groups.setdefault(key,{'id':x['id'],'occurrences':[]})['occurrences'].append(x)
grouped=list(groups.values());out={'scope':'Formal root candidates.json through frozen60 only; historical candidate records incl SKIP/unproven/downgraded, not current-active/unresolved count; no cause/current-status reassessment. Evidence/nested/archive copies and mutable61 not enumerated.','inputFiles':len(pins),'rawOccurrences':len(occ),'uniqueOriginalIDs':len(grouped),'recordsWithoutID':len(without),'duplicateIDOccurrencesBeyondFirst':len(occ)-len(without)-len(grouped),'candidatesByOriginalID':grouped,'recordsWithoutIDList':without,'perFileCounts':countchecks,'supplementalCollectionsSeparate':extraCollections,'limits':'Missing title/summary/hypothesis/status stays null. Display may show source reason without inventing a title/status. Promoted aliases remain original metadata; not automatically merged or deleted.'};save('candidate-history-list.json',out)
lines=['# 历史候选原记录（不是已确认问题或当前未解决数）','',f"正式根 candidates.json 共{len(pins)}份，{len(occ)}条出现，按原id去重{len(grouped)}项；无id原记录{len(without)}条。不重判当前状态、旧SKIP或是否已晋升。",'','| 原ID | 来源批次 | 原status | 原title/summary/hypothesis |','|---|---|---|---|']
def cell(v):
 if v is None:return '（原字段缺失）'
 return (v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)).replace('|','\\|').replace('\n',' ')
for g in grouped:
 xs=g['occurrences'];vals=[]
 for x in xs:
  item=cell(x['displayTextOriginalField'])
  if item not in vals:vals.append(item)
 statuses=[]
 for x in xs:
  z=cell(x['status'])
  if z not in statuses:statuses.append(z)
 lines.append('| '+cell(g['id'])+' | '+','.join('R'+str(x['sourceRound']) for x in xs)+' | '+' / '.join(statuses)+' | '+' / '.join(vals)+' |')
if without:
 lines+=['','## 无id记录','']
 for x in without:lines.append(f"- R{x['sourceRound']} {x['canonicalFile']}#{x['pointer']}：{cell(x['displayTextOriginalField'])}")
lines+=['','原对象、canonical路径与JSON pointer完整保存在 [candidate-history-list.json](candidate-history-list.json)。缺失字段保留null，不以推断内容补题目或状态。其它staticNotPromoted/alias数组单列，不混计上述候选。']
(O/'candidate-history-list.md').write_text('\n'.join(lines)+'\n')
summary={'formalHistoricalRecords':len(arr),'formalUniqueIDs':len(set(ids)),'formalPriorities':counts,'mdRecords':len(rows),'mdUniqueIDs':len(bymd),'IDSetSame':set(ids)==set(bymd),'allTitlePriorityCanonicalMappingsSame':not mismatch,'mismatches':mismatch,'coverage':diff,'candidateHistory':{k:out[k] for k in ['inputFiles','rawOccurrences','uniqueOriginalIDs','recordsWithoutID','duplicateIDOccurrencesBeyondFirst']},'candidateCountDiscrepancies':[x for x in countchecks if not x['declaredCountMatches']],'productExecution':0,'sourceBodyReads':0,'git':0};save('checks.json',summary);print(json.dumps(summary,ensure_ascii=False))
