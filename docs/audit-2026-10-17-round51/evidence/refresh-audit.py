"""Audit branch refresh and metadata snapshots only."""
from pathlib import Path
import hashlib,json,subprocess
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');P=Path('/Users/admin/Documents/个人学习/代码学习/codeshell');E=R/'docs/audit-2026-10-17-round51/evidence'
def git(*a,cwd=R):return subprocess.check_output(['git',*a],cwd=cwd)
def sha(b):return hashlib.sha256(b).hexdigest()
def snap():
 s=dict(primary=str(P),head=git('rev-parse','HEAD',cwd=P).decode().strip(),statusHex=git('status','--porcelain=v1','-z',cwd=P).hex(),trackedDiffSha256=sha(git('diff','--binary',cwd=P)),stagedDiffSha256=sha(git('diff','--cached','--binary',cwd=P)),untracked=[])
 for n in sorted(x.decode() for x in git('ls-files','--others','--exclude-standard','-z',cwd=P).split(b'\0') if x):
  b=(P/n).read_bytes();s['untracked'].append(dict(path=n,bytes=len(b),sha256=sha(b)))
 return s
p=json.loads((E/'integration-plan.json').read_text());before=snap();assert {k:v for k,v in before.items() if k!='head'}=={k:v for k,v in p['initialPrimary'].items() if k!='head'}
assert git('branch','--show-current').decode().strip()==p['branch'];assert not git('diff','--cached','--name-only').strip()
main=git('rev-parse','main').decode().strip();delta=git('diff','--name-only','-z',p['baseline'],main).split(b'\0');incoming=[x.decode() for x in delta if x]
assert all(not x.startswith('docs/audit-2026-10-17-round51/') for x in incoming)
git('merge','--ff-only','--no-stat',main)
assert snap()==before
p.update(refreshedMain=main,primaryBefore=before,endFetch=dict(session=87308,exitCode=0,originMain=git('rev-parse','origin/main').decode().strip()),incomingMainPaths=incoming,incomingReview='Path inventory only; selected sources checked separately, no semantic validation of concurrent fixes.')
(E/'integration-plan.json').write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n')
(E/'incoming-main-paths.json').write_text(json.dumps(dict(baseline=p['baseline'],main=main,paths=incoming,productRuns=0),ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(main=main,incoming=len(incoming),dirtyPreserved=True)))
