import './deny-network.mjs';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join, relative} from 'node:path';
const root='/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps';
const output='/tmp/codeshell-panel-video-review-20261012';
const {build}=await import(pathToFileURL(join(root,'node_modules/esbuild/lib/main.js')));
const {suites}=await import(pathToFileURL(join(root,'tests/suites.mjs')));
const suite=suites.find(x=>x.id==='video-studio');
const tsTests=suite.commands[0].slice(1);
const defaultEntries=[...tsTests,'apps/video-studio/native/voice-cli.ts','apps/video-studio/native/voice-runtime.ts'];
const nativeEntries=[
 'apps/video-studio/native/editor-runtime.ts','apps/video-studio/native/editor-sync.ts',
 'apps/video-studio/native/editor-runtime/multicam.ts','apps/video-studio/native/editor-runtime/runtime.ts',
 'apps/video-studio/native/editor-runtime/bundle.ts','apps/video-studio/native/editor-sync/provider.ts',
 'apps/video-studio/native/editor-runtime/proxy.ts','apps/video-studio/native/media/editor-audio-renderer.ts',
 'apps/video-studio/native/media/editor-export.ts','apps/video-studio/native/media/editor-frame-renderer.ts',
 'apps/video-studio/src/editor/task-bridge.ts','apps/video-studio/src/editor/defaults.ts',
 'apps/video-studio/src/editor/multicam-edits.ts','apps/video-studio/src/editor/clip-edits.ts',
 'apps/video-studio/src/editor/operations.ts','apps/video-studio/src/editor/export-settings.ts',
 'apps/video-studio/src/editor/portable-project.ts','apps/video-studio/src/editor/validation.ts',
 'apps/video-studio/src/editor/snapshot-sync.ts','apps/video-studio/src/editor/sync-bridge.ts',
 'apps/video-studio/src/editor/original-audio.ts','apps/video-studio/src/editor/audio-gain-edits.ts',
 'apps/video-studio/src/editor/render-entry.ts',
];
async function graph(entries,name){
 const result=await build({absWorkingDir:root,entryPoints:Object.fromEntries(entries.map((file,i)=>[String(i),file])),outdir:join(output,'graph-'+name),bundle:true,platform:'node',format:'esm',target:'node20',write:false,metafile:true,external:['panel-browser:editor-renderer'],logLevel:'silent'});
 const inputs=Object.keys(result.metafile.inputs).filter(x=>x.startsWith('apps/video-studio/src/')||x.startsWith('apps/video-studio/native/')).sort();
 await writeFile(join(output,name+'-dependency-graph.json'),JSON.stringify({meaning:'Bundler dependency graph, not line/branch coverage or proof every module function executed',entryPoints:entries,inputs},null,2)+'\n');
 return new Set(inputs);
}
const defaultGraph=await graph(defaultEntries,'default-suite');
const nativeGraph=await graph(nativeEntries,'native-suite');
const full=`src/editor/workspace-storage.ts
src/editor/portable-project.ts
src/editor/history.ts
src/editor/session.ts
src/editor/host-storage.ts
src/editor/types.ts
src/editor/defaults.ts
src/editor/export-submissions.ts
src/editor/export-batch.ts
src/editor/export-range.ts
src/editor/operations.ts
src/editor/audio-plan.ts
src/editor/evaluate.ts
src/editor/import-media.ts
src/editor/placement.ts
src/editor/rough-cut-placement.ts
src/local-voice-process.ts
src/sdk/panel-runtime.ts
src/workspace-document-bridge.ts
src/editor/snapshot-sync.ts
src/media-file-storage.ts
src/recording-cache.ts
src/workspace-layout.ts
src/editor/preview.ts
src/editor/render-entry.ts
src/editor/render-media-job.ts
src/media-task-bridge.ts
src/editor/audio-enhancement-controller.ts
src/editor/separation-controller.ts
src/editor/voiceover-publication.ts
src/external-media.ts
src/editor/browser-export.ts
src/editor/resource-upload.ts
src/editor/import-ui.ts
src/editor/time.ts
native/queue.ts
native/process-runner.ts
native/signals.ts
native/media/editor-export.ts
native/media/editor-frame-renderer.ts
native/media/editor-audio-renderer.ts
native/media/media-caption-renderer.ts
native/editor-runtime/files.ts
native/editor-runtime/protocol.ts
native/editor-runtime/runtime.ts`.split('\n');
const focused={
 'src/editor/task-bridge.ts':'1-620 and result/discard anchors; remaining contracts via existing tests',
 'src/editor/agent-tools.ts':'1290-1388 render/task publication and tool indexes',
 'src/editor/clip-edits.ts':'860-1224 retime/reverse/freeze/speed curves; other APIs indexed',
 'src/editor/timing-edits.ts':'reverse planner, dispatch action, grouped mapping guards',
 'src/editor/timing-ui.ts':'reverse button and shared edit callback',
 'src/editor/sequence-edits.ts':'export/function index only',
 'src/main.ts':'1965-2096 resource replacement; 5120-5160 unload; 6355-6579 boot/dispose; selected addMedia',
 'src/editor/workspace-ui.ts':'875-1120 preview cancellation, addAsset/addClip; caller anchors',
 'src/editor/validation.ts':'asset/time constraints and map/normalization anchors; schema tests executed',
 'src/model.ts':'export/function index only',
 'src/production.ts':'export/function index only',
 'src/media.ts':'export/function index only',
 'src/automatic.ts':'export/function index only',
 'src/workflow.ts':'export/function index only',
};
const fullSet=new Set(full);
async function walk(dir){let files=[];for(const ent of await readdir(dir,{withFileTypes:true})){const p=join(dir,ent.name);files.push(...(ent.isDirectory()?await walk(p):[relative(root,p)]));}return files;}
const files=(await Promise.all(['src','native'].map(d=>walk(join(root,'apps/video-studio',d))))).flat().sort();
const rows=[];
for(const path of files){
 const short=path.slice('apps/video-studio/'.length);
 const source=await readFile(join(root,path),'utf8');
 const isTest=short.includes('/tests/');
 const executedTest=tsTests.includes(path)||path==='apps/video-studio/native/tests/voice-runtime.test.mjs';
 rows.push({path,lines:source.split('\n').length-Number(source.endsWith('\n')),manualRead:fullSet.has(short)?'full':focused[short]?'focused':'not manually read',manualNotes:focused[short]??'',defaultSuiteGraph:defaultGraph.has(path),nativeSuiteGraph:nativeGraph.has(path),testFile:isTest,executedTestFile:executedTest});
}
await writeFile(join(output,'module-inventory.json'),JSON.stringify({root,head:'aabba34ca94f7081fd7de4e20c52443f08f36d5e',definitions:{full:'Full source read over one or several tool outputs',focused:'Only recorded sections/anchors read; not full-file review',graph:'Included in source dependency graph of executed suites; does not establish branch coverage or function execution'},rows},null,2)+'\n');
const csv=v=>'"'+String(v).replaceAll('"','""')+'"';
const columns=['path','lines','manualRead','manualNotes','defaultSuiteGraph','nativeSuiteGraph','testFile','executedTestFile'];
await writeFile(join(output,'module-inventory.csv'),[columns.join(','),...rows.map(r=>columns.map(k=>csv(r[k])).join(','))].join('\n')+'\n');
const counts={files:rows.length,lines:rows.reduce((n,r)=>n+r.lines,0),manualFull:rows.filter(r=>r.manualRead==='full').length,manualFocused:rows.filter(r=>r.manualRead==='focused').length,noManualRead:rows.filter(r=>r.manualRead==='not manually read').length,defaultSuiteGraph:rows.filter(r=>r.defaultSuiteGraph).length,nativeSuiteGraph:rows.filter(r=>r.nativeSuiteGraph).length,eitherSuiteGraph:rows.filter(r=>r.defaultSuiteGraph||r.nativeSuiteGraph).length,neitherSuiteGraph:rows.filter(r=>!r.defaultSuiteGraph&&!r.nativeSuiteGraph).length};
await writeFile(join(output,'inventory-summary.json'),JSON.stringify(counts,null,2)+'\n');
console.log(JSON.stringify(counts,null,2));
