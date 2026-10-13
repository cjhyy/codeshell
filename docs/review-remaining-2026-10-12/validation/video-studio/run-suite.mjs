import { spawn } from 'node:child_process';
process.env.NODE_OPTIONS='--import=/tmp/codeshell-panel-video-review-20261012/deny-network.mjs';
const p=spawn(process.execPath,['scripts/check.mjs','--tests-only','--suite','video-studio'],{stdio:'inherit',env:process.env,cwd:'/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps'});
p.once('exit',code=>process.exitCode=code??1);
