"""Owned documentation integration only; no product or test execution."""
from pathlib import Path
import hashlib,json,subprocess,re
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
PRIMARY=Path('/Users/admin/Documents/个人学习/代码学习/codeshell')
PREFIX='docs/audit-2026-10-17-round64/'
OUT=ROOT/PREFIX
EV=OUT/'evidence'
STEM=Path('/tmp/codeshell-audit-20261018-round64')
def sha(raw):return hashlib.sha256(raw).hexdigest()
def command(args,cwd=ROOT,check=True):
 r=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 if check and r.returncode:raise RuntimeError({'command':args,'exit':r.returncode,'output':r.stdout.decode(errors='replace')})
 return r

def git(*args,cwd=ROOT):return command(['git',*args],cwd).stdout

def snapshot():
 s={'primary':str(PRIMARY),'head':git('rev-parse','HEAD',cwd=PRIMARY).decode().strip(),'statusHex':git('status','--porcelain=v1','-z',cwd=PRIMARY).hex(),'trackedDiffSha256':sha(git('diff','--binary',cwd=PRIMARY)),'stagedDiffSha256':sha(git('diff','--cached','--binary',cwd=PRIMARY)),'untracked':[]}
 for name in sorted(raw.decode() for raw in git('ls-files','--others','--exclude-standard','-z',cwd=PRIMARY).split(b'\0') if raw):
  raw=(PRIMARY/name).read_bytes();s['untracked'].append({'path':name,'bytes':len(raw),'sha256':sha(raw)})
 return s

plan=json.loads((EV/'integration-plan.json').read_text())
assert (EV/'review-aggregate.md').is_file()
assert git('branch','--show-current').decode().strip()==plan['branch']
assert git('rev-parse','HEAD').decode().strip()==plan['refreshedMain']
assert snapshot()==plan['primaryBefore']
assert not git('diff','--cached','--name-only').strip()
status=git('status','--porcelain=v1','-z').split(b'\0')
assert all(raw[3:].decode().startswith(PREFIX) for raw in status if raw),status
verified=command(['python3',str(EV/'verify-audit.py')])
verification=json.loads(verified.stdout)
paths=sorted(str(path.relative_to(ROOT)) for path in OUT.rglob('*') if path.is_file())
assert all(not (ROOT/name).is_symlink() for name in paths)
validation=json.loads((OUT/'validation.json').read_text())
raw_paths=sorted(PREFIX+row['log'] for row in validation['runs'])
assert len(raw_paths)==0 and sorted(name for name in paths if name.endswith('.log'))==raw_paths
nonlogs=[name for name in paths if name not in raw_paths]
command(['git','add','--',*nonlogs])
if raw_paths:command(['git','add','-f','--',*raw_paths])
staged=sorted(raw.decode() for raw in git('diff','--cached','--name-only','-z').split(b'\0') if raw)
assert staged==paths
records=[]
for name in staged:
 raw=(ROOT/name).read_bytes();blob=git('show',':'+name);assert raw==blob
 records.append({'path':name,'bytes':len(raw),'sha256':sha(raw)})
full=command(['git','diff','--cached','--check'],check=False)
exempt=json.loads((EV/'frozen-artifact-whitespace.json').read_text())['exactArtifacts']
allowed={row['path']:set(row['trailingLineNumbers']) for row in exempt}
reviewed=json.loads((EV/'root-whitespace-review.json').read_text());assert {k:sorted(v) for k,v in allowed.items()}==reviewed['exactTrailingWhitespaceLines']
headers=[]
for text in full.stdout.decode(errors='replace').splitlines():
 m=re.match(r'^(.+?):(\d+): (?:trailing whitespace|new blank line at EOF)\.',text)
 if m:headers.append((m.group(1),int(m.group(2))))
expected_headers={(name,line) for name,lines in allowed.items() for line in lines}
expected_headers.update((row['path'],len((ROOT/row['path']).read_bytes().splitlines())) for row in exempt if row['newBlankLineAtEof'])
assert set(headers)==expected_headers
nonfrozen=[name for name in nonlogs if name not in allowed]
nonlog=command(['git','diff','--cached','--check','--',*nonfrozen],check=False)
stage_receipt={'before':snapshot(),'files':records,'verification':verification,'fullWhitespaceCheck':{'exitCode':full.returncode,'output':full.stdout.decode(errors='replace')},'nonFrozenWhitespaceCheck':{'exitCode':nonlog.returncode,'output':nonlog.stdout.decode(errors='replace')},'rawLogPaths':raw_paths,'frozenWhitespaceExemptions':exempt,'exactWhitespaceHeaders':headers,'productTestsRerun':False}
Path(str(STEM)+'-stage-verification.json').write_text(json.dumps(stage_receipt,ensure_ascii=False,indent=2)+'\n')
assert full.returncode==(2 if headers else 0) and nonlog.returncode==0
assert snapshot()==plan['primaryBefore']
command(['git','commit','-qm','docs(audit): record attachment retention bug and source review round64'])
commit=git('rev-parse','HEAD').decode().strip()
assert not git('status','--porcelain=v1','-z')
assert snapshot()==plan['primaryBefore']
command(['git','merge-base','--is-ancestor',plan['refreshedMain'],commit])
incoming=sorted(raw.decode() for raw in git('diff','--name-only','-z',plan['refreshedMain'],commit).split(b'\0') if raw)
assert incoming==paths and all(name.startswith(PREFIX) for name in incoming)
dirty_paths=set(raw.decode() for raw in git('diff','--name-only','-z','HEAD',cwd=PRIMARY).split(b'\0') if raw)
dirty_paths.update(raw.decode() for raw in git('ls-files','--others','--exclude-standard','-z',cwd=PRIMARY).split(b'\0') if raw)
assert all(new!=old and not new.startswith(old+'/') and not old.startswith(new+'/') for new in incoming for old in dirty_paths)
merge=command(['git','merge','--ff-only','--no-stat',commit],cwd=PRIMARY)
after=snapshot();assert after['head']==commit
assert {k:v for k,v in after.items() if k!='head'}=={k:v for k,v in plan['primaryBefore'].items() if k!='head'}
for row in verification.get('pendingPrimaryIntegrationLinks',[]):
 raw=Path(row['target']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256'] and raw==Path(row['mappedOwned']).read_bytes()
for row in records:
 raw=(PRIMARY/row['path']).read_bytes();blob=git('show',commit+':'+row['path']);assert len(raw)==row['bytes'] and sha(raw)==row['sha256'] and raw==blob
sources=json.loads((OUT/'source-manifest.json').read_text())
for row in sources['files']:assert sha((PRIMARY/row['path']).read_bytes())==row.get('currentSha256',row['sha256'])
assert not git('status','--porcelain=v1','-z')
receipt={'commit':commit,'branch':plan['branch'],'baseline':plan['baseline'],'mainBefore':plan['refreshedMain'],'primaryBefore':plan['primaryBefore'],'primaryAfter':after,'dirtyPreserved':True,'incomingPaths':incoming,'verification':verification,'stagedBlobChecks':len(records),'primaryAndCommitBlobChecks':len(records),'sourcePinsAtFinalPrimary':len(sources['files']),'rawLogsVerbatim':raw_paths,'fullWhitespaceCheckExit':full.returncode,'nonFrozenWhitespaceCheckExit':nonlog.returncode,'frozenWhitespaceExemptions':exempt,'pendingPrimaryLinksResolvedAfterIntegration':len(verification.get('pendingPrimaryIntegrationLinks',[])),'ownedWorktreeClean':True,'noPush':True,'productTestsRerun':False,'goalStillActive':True,'mergeOutput':merge.stdout.decode()}
Path(str(STEM)+'-integration.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'commit':commit,'files':len(records),'indexedFiles':verification['indexedFiles'],'links':verification['localMarkdownLinks'],'sources':len(sources['files']),'dirtyPreserved':True,'ownedWorktreeClean':True,'goalStillActive':True}))
