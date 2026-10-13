import './codeshell-quant-job-deny-network.mjs';
import test from 'node:test';
import rawAssert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const root='/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps';
const imp=p=>import(pathToFileURL(root+'/'+p).href);
const portfolio=await imp('apps/quant-lab/app/portfolio.mjs');
const {appendTransaction,deriveHoldingsSnapshot}=await imp('apps/quant-lab/app/portfolio-store.mjs');
const {importPortfolioSnapshot}=await imp('apps/quant-lab/app/portfolio-import.mjs');
const opportunities=await imp('apps/job-hunt-hq/app/job-opportunities.mjs');
const applications=await imp('apps/job-hunt-hq/app/application-model.mjs');
const {compactProjectSnapshotPayload}=await imp('apps/job-hunt-hq/app/snapshot-sharding-model.mjs');
const quantSource=await readFile(root+'/apps/quant-lab/app/modules/holdings-ui.mjs','utf8');
const jobSource=await readFile(root+'/apps/job-hunt-hq/app/app.js','utf8');
let assertions=0;
const assert=new Proxy(rawAssert,{apply(target,that,args){assertions++;return Reflect.apply(target,that,args)},get(target,key){const value=target[key];return typeof value==='function'?(...args)=>{assertions++;return value(...args)}:value}});
process.on('exit',()=>console.log('CUSTOM_ASSERTIONS',assertions));
const between=(source,start,end)=>{const a=source.indexOf(start);const b=source.indexOf(end,a+start.length);if(a<0||b<0)throw Error('source boundary missing');return source.slice(a,b)};
const baseLedger=()=>({format:'codeshell.portfolio-transactions',version:1,baseCurrency:'CNY',accounts:[{id:'acct',name:'Owned fixture',broker:'offline',currencies:['CNY']}],instruments:[{id:'stock',type:'stock',market:'cn',currency:'CNY',symbol:'SH600000',name:'Fixture stock',aliases:[]}],transactions:[{id:'cash',type:'cash-in',accountId:'acct',valuationDate:'2026-10-09',timing:'begin',currency:'CNY',amount:'10000.00',createdAt:'2026-10-09T00:00:00.000Z'}]});
function workspace(ledger, failure='none') {
 const files=new Map(ledger?[['portfolio/transactions.json',{content:JSON.stringify(ledger),revision:'r0',modifiedAt:0}]]:[]);
 let serial=0,failed=false;const calls=[];
 return {files,calls,async call(method,p){calls.push({method,path:p.path});
  if(method==='workspace.list')return {entries:[...files].map(([path])=>({kind:'file',path,name:path.split('/').at(-1)}))};
  if(method==='workspace.readText'){if(!files.has(p.path))throw Error('ENOENT');return {...files.get(p.path)}}
  if(method==='workspace.writeText'){
   const existing=files.get(p.path);
   if(p.expectedModifiedAt===null&&existing)throw Error('conflict: exists');
   if(p.expectedRevision&&p.expectedRevision!==existing?.revision)throw Error('conflict: revision');
   if(p.path==='portfolio/transactions.json'&&!failed&&failure==='before'){failed=true;throw Error('write unavailable before acceptance')}
   const result={content:p.content,revision:'r'+(++serial),modifiedAt:serial};files.set(p.path,result);
   if(p.path==='portfolio/transactions.json'&&!failed&&failure==='ack'){failed=true;throw Error('ack lost after commit')}
   return result;
  }throw Error(method);
 }};
}
function holdingsSave(f) {
 const element=value=>({value,disabled:false,focus(){}});
 const elements=Object.fromEntries(Object.entries({account:'acct',market:'cn',symbol:'SH600000',currency:'CNY',date:'2026-10-09',quantity:'100',price:'10.00',commission:'0',tax:'0',otherFees:'0',name:'Fixture stock',side:'buy'}).map(([k,v])=>[k,element(v)]));
 elements.save=element('');elements.formError=element('');
 const messages=[];
 const context=vm.createContext({structuredClone,Date,JSON,Error,appendTransaction,parseTransactions:portfolio.parseTransactions,elements,ledger:baseLedger(),ledgerExists:true,transactionCounter:0,saveInFlight:false,liveSnapshot:null,liveQuotes:null,quoteState:null,snapshot:null,market:null,ledgerFingerprintState:null,quotesActive:false,now:()=>new Date('2026-10-09T10:00:00.000Z'),currentEpoch:()=>0,hostCall:f.call.bind(f),EMPTY_LEDGER:baseLedger(),setFormError:v=>messages.push(v||''),showStatus:v=>messages.push(v),isoDate:()=>true,decimalInput:v=>v,canonicalSymbol:v=>v,resolveAShare:()=>({symbol:'SH600000',name:'Fixture stock'}),loadMarketInputs:async()=>({derivationInputs:{}}),quoteController:{reset(){},refresh(){}},computeRules(){},render(){},reasonLabel:v=>v});
 vm.runInContext(between(quantSource,'  function draftFromForm() {','  function syncCurrency() {')+'\nglobalThis.reviewSave=save;',context);
 return {context,elements,messages,save:()=>context.reviewSave()};
}
test('Quant control: acknowledged save commits exactly one buy and clears form',async()=>{
 const f=workspace(baseLedger());const ui=holdingsSave(f);await ui.save();
 const ledger=JSON.parse(f.files.get('portfolio/transactions.json').content);
 assert.equal(ledger.transactions.filter(t=>t.type==='buy').length,1);assert.equal(ui.elements.quantity.value,'');assert.equal(ui.context.snapshot.positionsByAccount[0].quantity,'100');
});
test('Quant control: failure before acceptance can be retried without a duplicate',async()=>{
 const f=workspace(baseLedger(),'before');const ui=holdingsSave(f);await ui.save();
 assert.equal(JSON.parse(f.files.get('portfolio/transactions.json').content).transactions.length,1);assert.equal(ui.elements.quantity.value,'100');
 await ui.save();const ledger=JSON.parse(f.files.get('portfolio/transactions.json').content);
 assert.equal(ledger.transactions.filter(t=>t.type==='buy').length,1);
});
test('QJ-01: lost ledger write acknowledgement keeps form enabled and retry duplicates the trade',async()=>{
 const f=workspace(baseLedger(),'ack');const ui=holdingsSave(f);await ui.save();
 let ledger=JSON.parse(f.files.get('portfolio/transactions.json').content);
 assert.equal(ledger.transactions.filter(t=>t.type==='buy').length,1);assert.equal(ui.elements.quantity.value,'100');assert.equal(ui.elements.save.disabled,false);assert.equal(ui.context.ledger.transactions.filter(t=>t.type==='buy').length,0);assert.ok(ui.messages.includes('ack lost after commit'));
 await ui.save();ledger=JSON.parse(f.files.get('portfolio/transactions.json').content);const buys=ledger.transactions.filter(t=>t.type==='buy');
 assert.equal(buys.length,2);assert.notEqual(buys[0].id,buys[1].id);assert.equal(deriveHoldingsSnapshot(JSON.stringify(ledger),{},'2026-10-09T10:00:00Z').positionsByAccount[0].quantity,'200');
 console.log('QJ-01_EVIDENCE',JSON.stringify({ids:buys.map(t=>t.id),quantities:buys.map(t=>t.quantity),resultingQuantity:ui.context.snapshot.positionsByAccount[0].quantity,messages:ui.messages}));
});
test('Quant control: exact screenshot import retry recognizes already committed identity after acknowledgement loss',async()=>{
 const f=workspace(null,'ack');const input={mode:'commit',expectedFingerprint:null,account:{id:'new',name:'Owned import',broker:'offline'},valuationDate:'2026-10-09',source:{marketDate:null,reference:'Owned test'},positions:[{symbol:'SH600000',name:'Fixture stock',quantity:'100',costBasis:'1000',marketValue:'1000'}]};
 await assert.rejects(importPortfolioSnapshot(f.call.bind(f),input),/ack lost/);const retry=await importPortfolioSnapshot(f.call.bind(f),input);
 assert.equal(retry.status,'already-imported');assert.equal(JSON.parse(f.files.get('portfolio/transactions.json').content).transactions.length,1);
});
function resumeExport({switchDuring='none',readFails=false}={}) {
 const writes=[],notices=[];let resolveRead,resolveReady;const waiting=new Promise(r=>resolveReady=r);let project='A';let readNumber=0;
 const makeState=label=>({jobs:[],profile:{name:label,photoDataUrl:''},resume:{versionId:'resume-'+label,kind:'base',category:label+'-category',title:label+' resume',markdown:label+' public resume',updatedAt:'2026-10-09T10:00:00Z',style:{template:'minimal'},claimEvidence:[{claim:label+' evidence'}],candidateQuestions:[]},resumeWorkspaceMode:'content'});
 const c=vm.createContext({Date,Error,JSON,TextEncoder,window:{codeshellPanel:{async call(method,p){const requestProject=project;if(method==='workspace.readText'){readNumber++;if(readNumber===1){if(switchDuring==='public')return new Promise(r=>{resolveRead=r;resolveReady()});if(readFails)throw Error('ENOENT')}if(readNumber===2&&switchDuring==='evidence')return new Promise(r=>{resolveRead=r;resolveReady()});throw Error('ENOENT')}
 if(method==='workspace.writeText'){writes.push({project:requestProject,...p});return {revision:'owned'}}throw Error(method)}}},projectEpoch:0,state:makeState('A'),resumeMarkdownArtifacts:[],resumeMarkdownDiscoveryCwd:'',activeResumeJob:()=>null,ensureResumePublicationReady:()=>true,normalizeResumeStyle:v=>v,isSupportedResumePhoto:()=>false,escapeResumeHtmlAttribute:v=>v,resumeRecordId:r=>r.versionId,notify:(...v)=>notices.push(v),persist(){},renderResumeWorkspace(){},refreshResumeMarkdownFiles:async()=>{},mockHostCall(){throw Error('no mock')}});
 vm.runInContext(between(jobSource,'async function hostCall(method, params) {','function panelHostRateLimited(')+between(jobSource,'function slugify(value) {','function notify(')+between(jobSource,'async function saveResumeToRepo() {','async function runResumeFileAction(')+'\nglobalThis.reviewExport=saveResumeToRepo;',c);
 return {c,writes,notices,waiting,run:()=>c.reviewExport(),switch(){project='B';c.projectEpoch++;c.state=makeState('B')},release(){resolveRead({content:'A old export',revision:'A-rev',modifiedAt:1})}};
}
test('Job control: same-project missing public file creates matching Markdown and evidence',async()=>{
 const f=resumeExport({readFails:true});await f.run();assert.equal(f.writes.length,2);assert.ok(f.writes.every(w=>w.project==='A'));assert.equal(f.writes[0].content,'A public resume');assert.equal(JSON.parse(f.writes[1].content).resumeVersionId,'resume-A');
});
test('QJ-02: switching projects during public file read causes writes in new project under old filename',async()=>{
 const f=resumeExport({switchDuring:'public'});const pending=f.run();f.switch();f.release();await pending;
 assert.equal(f.writes.length,2);assert.ok(f.writes.every(w=>w.project==='B'));assert.equal(f.writes[0].path,'job-hunt-resume-base-a-category.md');assert.equal(f.writes[0].content,'B public resume');assert.equal(JSON.parse(f.writes[1].content).resumeVersionId,'resume-B');assert.ok(f.notices.some(n=>n[0].includes('已保存')));
 console.log('QJ-02_PUBLIC_EVIDENCE',JSON.stringify({writes:f.writes,notices:f.notices}));
});
test('QJ-02: switching during evidence read saves B evidence beside already written A resume filename',async()=>{
 const f=resumeExport({switchDuring:'evidence'});const pending=f.run();await f.waiting;f.switch();f.release();await pending;
 assert.equal(f.writes.length,2);assert.equal(f.writes[0].project,'A');assert.equal(f.writes[1].project,'B');assert.equal(JSON.parse(f.writes[1].content).resumeVersionId,'resume-B');assert.equal(f.writes[1].path,'job-hunt-resume-base-a-category.evidence.json');
});
const description='岗位职责：负责前端产品开发、维护业务模块、改进测试和质量。'.repeat(8)+'任职要求：熟悉 JavaScript 和组件开发，具备合作能力。'.repeat(6);
const fullJob=(id='job-new',company='New Company')=>({id,company,title:'Engineer',url:'https://example.invalid/'+id,description,jdCompleteness:'full',status:'inbox',updatedAt:'2026-10-09T10:00:00Z'});
const keyContext=vm.createContext({URL,normalizeSourceId:()=> 'other'});
vm.runInContext(between(jobSource,'function normalizeJobUrl(value) {','function normalizeResumeEditorDraft('),keyContext);
const keys={dedupeKey:keyContext.jobDedupeKey,metadataKey:keyContext.jobMetadataKey};
test('QJ-03: duplicate opportunities in one batch persist twice; sequential batches deduplicate',()=>{
 const a=fullJob('one','Same Company');const b={...a,id:'two'};const sameBatch=opportunities.upsertJobDiscovery([],[],[a,b],keys);
 assert.equal(sameBatch.jobs.length,2);assert.equal(new Set(sameBatch.jobs.map(j=>j.id)).size,2);assert.equal(sameBatch.insertedJobs.length,2);
 const first=opportunities.upsertJobDiscovery([],[],[a],keys);const second=opportunities.upsertJobDiscovery(first.jobs,[],[b],keys);
 assert.equal(second.jobs.length,1);assert.equal(second.jobs[0].id,'one');
 console.log('QJ-03_EVIDENCE',JSON.stringify({sameBatch:sameBatch.jobs.map(j=>({id:j.id,url:j.url})),sequentialIds:second.jobs.map(j=>j.id)}));
});
function opportunityHandler(existingCount) {
 const jobs=Array.from({length:existingCount},(_,i)=>fullJob('old-'+i,'Company '+i));const oldest=jobs.at(-1);oldest.status='applied';oldest.application={nextAction:'Follow up on application',history:[{stage:'applied',note:'Owned saved application detail'}]};
 const snapshots=[];let handler;const state={jobs,jobLeads:[],selectedJobId:oldest.id,jobSourceFilter:'all',activeView:'dashboard',resume:{kind:'variant',versionId:'variant',jobId:oldest.id,markdown:'Old application resume'}};
 const c=vm.createContext({Date,JSON,Error,state,ready:Promise.resolve(),register:(name,fn)=>handler=fn,normalizeJobUrl:keyContext.normalizeJobUrl,normalizeSourceId:()=> 'other',normalizeJobApplication:applications.normalizeJobApplication,uid:()=> 'owned-fixture-id',clone:structuredClone,...opportunities,...keys,jobDedupeKey:keys.dedupeKey,jobMetadataKey:keys.metadataKey,formalJdPath:j=>'career-data/jd/'+j.id+'.md',formalJdMarkdown:j=>j.description,upsertWorkspaceText:async()=>{},persist(){},renderAll(){},renderMaterials(){},recordTraceArtifact(){},requireProjectSnapshot(){},writeProjectSnapshot:async()=>{snapshots.push(compactProjectSnapshotPayload(state));return true}});
 vm.runInContext(between(jobSource,'function assertPlainObject(value, name) {','function registerAgentTools(')+between(jobSource,'  register("save_job_opportunities",','  register("update_application_progress",'),c);
 return {c,run:incoming=>handler({jobs:incoming}),snapshots,oldestId:oldest.id};
}
test('QJ-04: adding the 81st formal opportunity silently removes saved application progress from snapshot',async()=>{
 const f=opportunityHandler(80);const result=await f.run([fullJob()]);
 assert.equal(result.projectSaved,true);assert.equal(result.totalJobs,80);assert.equal(result.inboxAdded,1);assert.equal(f.c.state.jobs.some(j=>j.id===f.oldestId),false);assert.equal(f.snapshots[0].jobs.some(j=>j.id===f.oldestId),false);assert.equal(f.snapshots[0].resume.jobId,f.oldestId);assert.equal(f.snapshots[0].jobs.some(j=>j.application?.history?.some(e=>e.note==='Owned saved application detail')),false);
 console.log('QJ-04_EVIDENCE',JSON.stringify({result,lostApplicationId:f.oldestId,retainedLinkedResumeJobId:f.snapshots[0].resume.jobId}));
});
test('Job capacity controls: 79 plus new and 80 plus update preserve original application',async()=>{
 const below=opportunityHandler(79);await below.run([fullJob()]);assert.equal(below.c.state.jobs.length,80);assert.ok(below.c.state.jobs.some(j=>j.id===below.oldestId));
 const same=opportunityHandler(80);await same.run([{...same.c.state.jobs[0],id:'incoming-update',description:description+' Updated'}]);assert.equal(same.c.state.jobs.length,80);assert.ok(same.c.state.jobs.some(j=>j.id===same.oldestId));
});
