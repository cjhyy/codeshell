"""Create at origin/main, fast-forward the new unoccupied branch, then switch once."""
from pathlib import Path
import json,hashlib,subprocess
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');P=Path('/Users/admin/Documents/个人学习/代码学习/codeshell');PREFIX='docs/audit-2026-10-17-round51/';B='codex/audit/context-usage-and-panel-sizing-round51-20261017'
def git(*a,cwd=R):return subprocess.check_output(['git',*a],cwd=cwd)
def sha(b):return hashlib.sha256(b).hexdigest()
def snap():
 s=dict(primary=str(P),head=git('rev-parse','HEAD',cwd=P).decode().strip(),statusHex=git('status','--porcelain=v1','-z',cwd=P).hex(),trackedDiffSha256=sha(git('diff','--binary',cwd=P)),stagedDiffSha256=sha(git('diff','--cached','--binary',cwd=P)),untracked=[])
 for n in sorted(x.decode() for x in git('ls-files','--others','--exclude-standard','-z',cwd=P).split(b'\0') if x):
  b=(P/n).read_bytes();s['untracked'].append(dict(path=n,bytes=len(b),sha256=sha(b)))
 return s
assert not git('status','--porcelain=v1','-z');before=snap();worktrees=git('worktree','list','--porcelain').decode();origin=git('rev-parse','origin/main').decode().strip();main=git('rev-parse','main').decode().strip();frozen=git('rev-parse','HEAD').decode().strip();assert main==before['head'];assert frozen=='424ef9c8953eaaa295d24d63c49127aa8b3ea79e';git('merge-base','--is-ancestor',frozen,main);assert not (R/PREFIX).exists()
git('merge-base','--is-ancestor',origin,main);git('merge-base','--is-ancestor',origin,frozen);git('branch',B,origin);assert 'branch refs/heads/'+B+'\n' not in git('worktree','list','--porcelain').decode();git('update-ref','refs/heads/'+B,frozen,origin);git('switch',B);assert snap()==before
o=R/PREFIX;e=o/'evidence';e.mkdir(parents=True);plan=dict(branch=B,baseline=frozen,originMain=origin,refreshedMain=frozen,mainAtBranchSelection=main,initialPrimary=before,primaryBefore=before,initialFetch=dict(session=24754,exitCode=0),scope='Ordinary Renderer context usage/boundary/time and panel sizing static source reviews. Frozen424ef product bytes retained until all readers freeze; no product/helper/test/DOM/native/network experiments.',branchMethod='Create exact new branch at origin/main; prove ancestry and no worktree occupancy; CAS fast-forward its ref to the frozen owned head before switching, leaving active workers product bytes unchanged. Concurrent local main, if ahead, will be merged only after source workers freeze. No intermediate old-source checkout.',instructionsSha256={n:sha((R/n).read_bytes()) for n in ['CODESHELL.md','AGENTS.md']})
(e/'integration-plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n');(e/'integration-before.json').write_text(json.dumps(before,ensure_ascii=False,indent=2)+'\n');(e/'worktrees-before.json').write_text(json.dumps(dict(text=worktrees),ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(branch=B,baseline=frozen,dirtyPreserved=True,intermediateOldSourceCheckout=False)))
