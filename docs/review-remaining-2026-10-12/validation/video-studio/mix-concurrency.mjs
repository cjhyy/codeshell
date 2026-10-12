import './deny-network.mjs';
import assert from 'node:assert/strict';import {build} from '/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/node_modules/esbuild/lib/main.js';import {mkdir,writeFile,copyFile,readFile,rm} from 'node:fs/promises';import {createHash,randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const root='/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps',dir='/tmp/codeshell-panel-video-review-20261012/concurrency';await mkdir(dir,{recursive:true});
await build({stdin:{contents:`export * from './apps/video-studio/native/editor-runtime/runtime';export * from './apps/video-studio/src/editor/defaults';export * from './apps/video-studio/src/editor/task-bridge';`,resolveDir:root},outfile:dir+'/api.mjs',bundle:true,platform:'node',format:'esm',banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
const a=await import(pathToFileURL(dir+'/api.mjs'));
const source=dir+'/tone.wav';const ff=spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','aevalsrc=0.2*sin(2*PI*440*t):s=48000:d=3','-c:a','pcm_f32le','-y',source]);assert.equal(ff.status,0,ff.stderr.toString());const sourceBytes=await readFile(source),hash=b=>createHash('sha256').update(b).digest('hex'),id='asset-'+hash(sourceBytes),scope='c'.repeat(64),runtimeDir=dir+'/runtime';await mkdir(runtimeDir,{recursive:true});
let count=0;
async function run(request,progress=()=>{}){const jobDir=dir+'/job-'+(++count);await mkdir(jobDir+'/inputs',{recursive:true});if(request.action==='stage-resources')await copyFile(source,jobDir+'/inputs/resource-0.bin');return a.runEditorRequest(request,{jobDir,runtimeDir,scopeKey:scope,jobId:'job-'+count,signal:new AbortController().signal,runtimeSource:'none',runtimeSha:hash('none'),reportProgress:progress});}
await rm(runtimeDir+'/scopes/'+scope,{recursive:true,force:true});
const outcomes=[];
for(let round=0;round<12;round++){
 await rm(runtimeDir+'/scopes/'+scope+'/cache/pcm',{recursive:true,force:true});
 const duration=720000,doc={schemaVersion:2,timebase:240000,id:'review-concurrent',name:'Review',revision:round,assets:[{id:'source',name:'Owned tone',kind:'audio',duration,resourceId:id}],sequences:[{id:'main',name:'main',width:32,height:32,frameRate:{numerator:30,denominator:1},background:'#000000',timelineMode:'free',tracks:[a.createTrack('a','audio')],clips:[{id:'clip',kind:'media',assetId:'source',trackId:'a',start:0,duration,label:'tone',timeMap:{points:[{time:0,source:0},{time:duration,source:duration}]},audio:a.defaultAudioMix(),transform:a.defaultTransform(),color:a.defaultColorAdjustment(),blendMode:'normal'}],transitions:[],markers:[]}],activeSequenceId:'main',exportProfiles:[]};
 const bytes=Buffer.from(JSON.stringify(a.editorTaskDocument(doc,'main').document)),documentHash=hash(bytes),transfers=[];
 for(let n=0;n<2;n++){const transferId='editor-'+randomUUID();transfers.push(transferId);await run({action:'stage-resources',transferId,resourceIds:[id]});await run({action:'stage-document',transferId,documentHash,chunkIndex:0,chunkCount:1,dataBase64:bytes.toString('base64')});await run({action:'commit',transferId,documentHash,sequenceId:'main',chunkCount:1,byteLength:bytes.length});}
 let startSecond,releaseReady;const secondStarted=new Promise(r=>startSecond=r),readyBarrier=new Promise(r=>releaseReady=r);let ready=0;
 const progress=first=>async p=>{if(first&&p.stage==='prepare-audio'&&p.fraction>0.5&&p.fraction<0.9)startSecond();if(p.stage==='prepare-audio'&&p.fraction===0.9){if(++ready===2)releaseReady();await readyBarrier;}if(first&&p.stage==='prepare-audio'&&p.fraction>0.5&&p.fraction<0.9)await new Promise(r=>setTimeout(r,2));};
 const request=i=>({action:'prepare-audio',transferId:transfers[i],documentHash,sequenceId:'main'});
 const first=run(request(0),progress(true));await secondStarted;const second=run(request(1),progress(false));
 await Promise.all([first,second]);
 try{const checked=await run(request(0));outcomes.push({round,reused:checked.result.reused,ok:true});}catch(e){outcomes.push({round,code:e.code,message:e.message,ok:false});}
 if(outcomes.at(-1).ok===false)break;
}
console.log(JSON.stringify(outcomes,null,2));
