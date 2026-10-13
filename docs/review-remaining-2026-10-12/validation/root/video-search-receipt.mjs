import './deny-network.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = '/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps';
const require = createRequire(root + '/package.json');
const { build } = require('esbuild');
const { chromium } = require('playwright');
const built = await build({entryPoints:[root + '/apps/video-download/app/video-search.js'],bundle:true,write:false,format:'iife',globalName:'VideoSearchReview'});
const browser = await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
try {
 for (const loseReceipt of [false, true]) {
  const page = await browser.newPage();
  let browserRequests = 0;
  await page.route('**/*', route => { browserRequests++; return route.abort(); });
  await page.setContent('<main id="app"></main>');
  await page.addScriptTag({content:built.outputFiles[0].text});
  const receipt = await page.evaluate(async loseReceipt => {
   const jobs = [], calls = [], snapshots = [];
   const panel = { async call(method,args) {
    calls.push({method,args});
    if (method === 'agent.task.models') return {models:[{id:'offline-model',label:'Offline Fixture',provider:'fixture'}],defaultModel:'offline-model'};
    if (method === 'agent.task.list') return jobs;
    if (method === 'agent.task.start') {
     const job = {id:'owned-task-'+(jobs.length+1),key:args.key,status:'running',model:args.model,updatedAt:Date.now()};
     jobs.push(job);
     if (loseReceipt) throw new Error('owned bridge receipt lost after acceptance');
     return job;
    }
    if (method === 'agent.task.get') return jobs.find(j=>j.id===args.id);
    if (method === 'agent.task.cancel') { const job=jobs.find(j=>j.id===args.id); job.status='cancelled'; return job; }
    throw new Error('unexpected '+method);
   }};
   const search = VideoSearchReview.mountVideoSearch({panel,container:document.querySelector('#app'),searchCandidates:async()=>[],pendingStorage:{load:async()=>null,save:async value=>{snapshots.push(structuredClone(value));}}});
   await search.ready;
   const first = search.startFromChat({query:'owned offline topic'});
   await first;
   for(let i=0;i<10;i++) await new Promise(r=>setTimeout(r,0));
   const afterFirst = search.getState();
   let second;
   try { second = await search.startFromChat({query:'owned offline topic'}); }
   catch(error) { second = {error:error.message}; }
   for(let i=0;i<10;i++) await new Promise(r=>setTimeout(r,0));
   const result = {loseReceipt,afterFirst,second,jobs:structuredClone(jobs),calls:structuredClone(calls),lastSnapshot:snapshots.at(-1)};
   search.destroy();
   return result;
  }, loseReceipt);
  console.log(JSON.stringify(receipt));
  if (loseReceipt) {
   assert.equal(receipt.afterFirst.status,'error');
   assert.equal(receipt.afterFirst.taskId,'');
   assert.equal(receipt.lastSnapshot,null);
   assert.equal(receipt.jobs.length,2);
   assert.ok(receipt.jobs.every(j=>j.status==='running'));
   assert.notEqual(receipt.jobs[0].key,receipt.jobs[1].key);
   assert.equal(receipt.calls.filter(c=>c.method==='agent.task.cancel').length,0);
  } else {
   assert.equal(receipt.afterFirst.status,'planning');
   assert.match(receipt.second.error,/已有查询/);
   assert.equal(receipt.jobs.length,1);
  }
  assert.equal(browserRequests,0);
  await page.close();
 }
 console.log(JSON.stringify({cases:2,realModels:0,browserNetworkRequests:0}));
} finally { await browser.close(); }
