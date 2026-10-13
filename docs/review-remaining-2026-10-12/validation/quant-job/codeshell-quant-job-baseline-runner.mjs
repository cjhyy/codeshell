import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const root='/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps';
const guard='/tmp/codeshell-quant-job-deny-network.mjs';
const quantScripts=['panel-host-calls','portfolio','portfolio-rules','portfolio-data','today','news','notes','history-data','market-data-sources','market-insights','stock-screener','market-pulse','a-share-selection','a-share-stock-detail','us-stock-detail','a-share-history'];
const quantTests=readdirSync(root+'/tests/apps/quant-lab').filter(f=>f.endsWith('.test.mjs')&&!['execution-binding-ui.test.mjs','selection-signal-browser.test.mjs'].includes(f)).map(f=>'tests/apps/quant-lab/'+f);
const jobTests=readdirSync(root+'/tests/apps/job-hunt-hq').filter(f=>f.endsWith('.test.mjs')&&!['draft-ui.test.mjs','interview-transcribe-native.test.mjs','resume-pdf-native.test.mjs'].includes(f)).map(f=>'tests/apps/job-hunt-hq/'+f);
let failed=0;
for(const args of [...quantScripts.map(f=>['scripts/quant-lab-'+f+'.mjs']),['--test',...quantTests],['--test',...jobTests]]) {
 console.log('REVIEW_COMMAND',JSON.stringify(args));
 const result=spawnSync(process.execPath,['--import',guard,...args],{cwd:root,env:{...process.env,NODE_OPTIONS:'--import '+guard},stdio:'inherit'});
 if(result.error)console.error(result.error);
 console.log('REVIEW_EXIT',result.status);
 if(result.status!==0)failed++;
}
console.log('REVIEW_SUMMARY',JSON.stringify({commands:18,quantScripts:quantScripts.length,quantTestFiles:quantTests.length,jobTestFiles:jobTests.length,failed}));
process.exitCode=failed?1:0;
