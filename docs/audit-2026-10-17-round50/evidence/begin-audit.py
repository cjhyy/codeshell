"""Create at origin/main, fast-forward the new unoccupied branch, then switch once."""
from pathlib import Path
import json,hashlib,subprocess
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');P=Path('/Users/admin/Documents/个人学习/代码学习/codeshell');PREFIX='docs/audit-2026-10-17-round50/';B='codex/audit/scroll-query-and-renderer-data-round50-20261017'
def git(*a,cwd=R):return subprocess.check_output(['git',*a],cwd=cwd)
def sha(b):return hashlib.sha256(b).hexdigest()
def snap():
 s=dict(primary=str(P),head=git('rev-parse','HEAD',cwd=P).decode().strip(),statusHex=git('status','--porcelain=v1','-z',cwd=P).hex(),trackedDiffSha256=sha(git('diff','--binary',cwd=P)),stagedDiffSha256=sha(git('diff','--cached','--binary',cwd=P)),untracked=[])
 for n in sorted(x.decode() for x in git('ls-files','--others','--exclude-standard','-z',cwd=P).split(b'\0') if x):
  b=(P/n).read_bytes();s['untracked'].append(dict(path=n,bytes=len(b),sha256=sha(b)))
 return s
assert not git('status','--porcelain=v1','-z');before=snap();worktrees=git('worktree','list','--porcelain').decode();origin=git('rev-parse','origin/main').decode().strip();main=git('rev-parse','main').decode().strip();assert main==before['head'];assert main==git('rev-parse','HEAD').decode().strip(),'Do not change active workers product bytes during branch selection';assert not (R/PREFIX).exists()
git('merge-base','--is-ancestor',origin,main);git('branch',B,origin);assert 'branch refs/heads/'+B+'\n' not in git('worktree','list','--porcelain').decode();git('update-ref','refs/heads/'+B,main,origin);git('switch',B);assert snap()==before
o=R/PREFIX;e=o/'evidence';e.mkdir(parents=True);plan=dict(branch=B,baseline=main,originMain=origin,refreshedMain=main,initialPrimary=before,primaryBefore=before,initialFetch=dict(session=68978,exitCode=0),scope='Static Web scrolling and trace-query continuation, finite Renderer metadata selection and ordinary presentation/suggestion/parameter source review. No product/helper/test/browser/native/runtime experiment.',branchMethod='Create exact new branch at origin/main; prove ancestry and no worktree occupancy; CAS fast-forward its ref to local main before switching. No intermediate old-source checkout.',instructionsSha256={n:sha((R/n).read_bytes()) for n in ['CODESHELL.md','AGENTS.md']})
(e/'integration-plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n');(e/'integration-before.json').write_text(json.dumps(before,ensure_ascii=False,indent=2)+'\n');(e/'worktrees-before.json').write_text(json.dumps(dict(text=worktrees),ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(branch=B,baseline=main,dirtyPreserved=True,intermediateOldSourceCheckout=False)))
