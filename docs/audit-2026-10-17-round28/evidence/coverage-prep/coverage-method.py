"""Pure filesystem/JSON/text metadata coverage selection. Never imports product modules or invokes them."""
from pathlib import Path
import json,re,hashlib,datetime,collections
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round28-coverage-frontier')
read=json.loads((out/'package-inventory.json').read_text());inventory={r['path']:r for r in read['files']};records=collections.defaultdict(dict);manifests=[];errors=[];scopes=collections.Counter();skips=collections.Counter()
full_labels={'full','full-static','full source','full-source','full file','full-file','full read','full-read','全文','完整全文','全文阅读'}
selected_labels={'selected','selected-static','selected ranges','selected-ranges','partial','选段','selected source','selected-source'}
def sha(b):return hashlib.sha256(b).hexdigest()
def walk(v,loc='$'):
 if isinstance(v,dict):
  yield loc,v
  for k,x in v.items():yield from walk(x,loc+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from walk(x,loc+f'[{i}]')
def ranges(v):
 if not isinstance(v,list):return []
 result=[]
 for a in v:
  if isinstance(a,list) and len(a)==2 and all(isinstance(n,int) and not isinstance(n,bool) for n in a) and 1<=a[0]<=a[1]:result.append(a)
 return sorted(result)
def scope(row):
 raw=row.get('coverage',row.get('readScope'))
 label=raw.strip().lower() if isinstance(raw,str) else ''
 selected=ranges(row.get('selectedLineRanges',row.get('lineRanges',row.get('ranges'))))
 if label in full_labels:return 'explicit-full',raw,selected
 if label in selected_labels:return 'explicit-selected',raw,selected
 if 'hash' in label or 'inventory' in label:return 'explicit-hash-or-inventory-only',raw,selected
 if selected:return 'explicit-ranges-without-full-claim',raw,selected
 return 'scope-unknown-pin-only',raw,selected
for dirname in ['docs','bugs']:
 for p in sorted((root/dirname).rglob('*.json')):
  if 'source-manifest' not in p.name:continue
  raw=p.read_bytes();rel=str(p.relative_to(root));manifests.append(dict(path=rel,bytes=len(raw),sha256=sha(raw)))
  try:d=json.loads(raw)
  except Exception as error:errors.append(dict(path=rel,error=str(error)));continue
  for loc,row in walk(d):
   path=row.get('path')
   if not isinstance(path,str):continue
   if path.startswith(str(root)+'/'):path=path[len(str(root))+1:]
   if path not in inventory:continue
   # A frozen/read SHA is authoritative for that claim. Never substitute a newer
   # currentSha256 for a stale frozen row to promote its coverage to current code.
   pin=next((row[k] for k in ['sha256','firstFilesystemSha256','frozenSha256','currentFilesystemSha256','finishFilesystemSha256'] if isinstance(row.get(k),str) and re.fullmatch('[0-9a-f]{64}',row[k])),None)
   if pin is None:skips['path-without-valid-sha256']+=1;continue
   kind,label,rs=scope(row);scopes[kind]+=1
   same=pin==inventory[path]['sha256'];key=json.dumps([pin,kind,label,rs],ensure_ascii=False)
   rec=records[path].setdefault(key,dict(sourceSha256=pin,matchesCurrentFilesystem=same,coverageKind=kind,rawCoverageLabel=label,selectedLineRanges=rs,validRangeBoundsForCurrentFile=(all(z<=inventory[path]['lines'] for a,z in rs) if same else None),manifests=[]))
   rec['manifests'].append(dict(path=rel,jsonLocation=loc))
def union_size(rs):
 merged=[]
 for a,b in sorted(rs):
  if merged and a<=merged[-1][1]+1:merged[-1][1]=max(b,merged[-1][1])
  else:merged.append([a,b])
 return sum(b-a+1 for a,b in merged),merged
index=[];coverage_counts=collections.Counter()
for path,current in sorted(inventory.items()):
 rows=list(records[path].values());same=[r for r in rows if r['matchesCurrentFilesystem']];full=[r for r in same if r['coverageKind']=='explicit-full'];selected=[r for r in same if r['coverageKind'] in ['explicit-selected','explicit-ranges-without-full-claim']];knownranges=[rs for r in selected if r['validRangeBoundsForCurrentFile'] for rs in r['selectedLineRanges']];u,merged=union_size(knownranges)
 if full:status='current-sha-explicit-full-claim'
 elif selected:status='current-sha-selected-only'
 elif same:status='current-sha-pin-only-no-semantic-coverage'
 elif rows:status='prior-version-only'
 else:status='no-matching-source-manifest-row'
 coverage_counts[status]+=1
 index.append(dict(**current,status=status,currentFullClaimVariants=len(full),currentSelectedClaimVariants=len(selected),currentSelectedUnionLines=u,currentSelectedUnionRanges=merged,priorVersionClaimVariants=sum(not r['matchesCurrentFilesystem'] for r in rows),currentPinOnlyVariants=sum(r['coverageKind'] in ['explicit-hash-or-inventory-only','scope-unknown-pin-only'] for r in same),claimVariants=len(rows),claims=rows))
# Ranking is a proposal inventory only, not a safety proof. No source function executes.
exclude=re.compile(r'(?:^packages/(?:optimization-lab|arena)/|(?:^|/)(?:auth|credentials|security|permissions?|custody|identity|sandbox|path-policy|session-authority)|(?:test|fixture|bench|mock|spec)\.|(?:^|/)(?:index|types|constants|schema|registry|manifest)\.tsx?$|(?:sliceAnsi|parseDocument|output-clean|composeFileEdits|fileChangeAggregator|reviewSnapshot|parseUnifiedDiff|lsp|frontmatter|thinking|recorder|ndjson|multi-?select|i18n|semver)(?:[./-]|$))',re.I)
ranks=[]
for row in index:
 if row['lines']>180 or row['lines']<10 or exclude.search(row['path']):continue
 text=(root/row['path']).read_text();runtime_imports=[];type_imports=[]
 for line in text.splitlines():
  stripped=line.strip()
  if stripped.startswith('import type '):type_imports.append(stripped)
  elif stripped.startswith('import ') or re.search(r'\b(?:require|import)\s*\(',stripped):runtime_imports.append(stripped)
 if runtime_imports:continue
 # Exclude textual ambient/native/UI/process/network/credential references, even
 # when a static review would be possible. A false positive only lowers priority.
 if re.search(r'\b(?:process|window|document|navigator|fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|Deno|Bun|crypto|spawn|execFile|permission|credential|token|secret|auth|authority|sandbox)\b',text,re.I):continue
 candidate=dict(path=row['path'],bytes=row['bytes'],lines=row['lines'],sha256=row['sha256'],coverageStatus=row['status'],currentFullClaimVariants=row['currentFullClaimVariants'],currentSelectedUnionLines=row['currentSelectedUnionLines'],priorVersionClaimVariants=row['priorVersionClaimVariants'],claimVariants=row['claimVariants'],runtimeImportLines=runtime_imports,typeOnlyImportLineCount=len(type_imports),requiresRootSourceReadAndBoundaryReview=True)
 ranks.append(candidate)
order={'no-matching-source-manifest-row':0,'prior-version-only':1,'current-sha-pin-only-no-semantic-coverage':2,'current-sha-selected-only':3,'current-sha-explicit-full-claim':4}
ranks.sort(key=lambda r:(order[r['coverageStatus']],r['claimVariants'],r['lines'],r['path']))
summary=dict(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),parentReportedBaseline=read['parentReportedBaseline'],baselineNotIndependentlyGitVerified=True,currentPackageFiles=len(inventory),currentPackageLines=sum(r['lines'] for r in inventory.values()),sourceManifestFiles=len(manifests),sourceManifestParseErrors=errors,rawEligibleRowsByScope=dict(scopes),skippedRows=dict(skips),coverageStatusCounts=dict(coverage_counts),zeroRuntimeImportTextCandidateCount=len(ranks),excluded='Long-standing skipped directions; optimization-lab and arena; tests/fixtures; auth/permission/security/custody/identity/sandbox; obvious native/UI/network/account references; and existing focused diff/parser families. Regex exclusion is a conservative proposal filter, not semantic safety validation.',limits=['Only explicit path+SHA and coverage/ranges in source-manifest-named JSON are extracted. Other prose, source-check receipts and unstructured claims are not credited.','Full is accepted only for a small explicit-label allowlist. Selected unions remain selected even if combined line ranges cover the whole file.','Rows with no read scope remain pin-only; hashes never imply semantic reading. Duplicate/copied claim variants do not count as independent audits.','Old/full read claims stay prior-version-only when their pinned SHA differs; a row newer currentSha256 cannot replace its frozen/read SHA.','This scan verifies metadata shape and current byte identity, not old authors\' coverage honesty, semantic exhaustion, test correctness or repository completion.','No product/module import, AST/VM/eval, test/helper function, Git, native/model/network/HOME/account execution.'],gitCommands=0,productExecution=False)
(out/'source-manifest-inventory.json').write_text(json.dumps(dict(files=manifests,count=len(manifests),parseErrors=errors),ensure_ascii=False,indent=2)+'\n')
(out/'coverage-index.json').write_text(json.dumps(dict(summary=summary,inventoryReference='package-inventory.json',onlyPathsWithPriorManifestRows=True,unmatchedInventoryPathCount=coverage_counts['no-matching-source-manifest-row'],files=[row for row in index if row['claims']]),ensure_ascii=False,indent=2)+'\n')
(out/'coverage-ranking.json').write_text(json.dumps(dict(summary=summary,rankedCandidates=ranks),ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(summary=summary,topCandidates=ranks[:45]),ensure_ascii=False))
