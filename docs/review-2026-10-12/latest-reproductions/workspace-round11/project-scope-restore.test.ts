import { fileURLToPath } from "node:url";
const PRODUCT_REVIEW_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const repo=PRODUCT_REVIEW_ROOT;
const isolation=await import(repo+'/scripts/runtime-cost-smoke-isolation.mjs');
isolation.installLocalNetworkGuard('http://127.0.0.1:9');
const { ProjectStore }=await import(repo+'/packages/desktop/src/main/project-store.ts');
const { SessionCwdIndex }=await import(repo+'/packages/desktop/src/main/session-cwd-index.ts');
const { createDesktopPanelProjectScopeResolver }=await import(repo+'/packages/desktop/src/main/panel-project-scope.ts');
const folders:string[]=[];
afterEach(()=>{for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true});});

test('registered secondary shares project identity when selected directly; mixed primary binding still refuses it; re-add needs a fresh grant after observed revocation',async()=>{
  const folder=realpathSync(mkdtempSync(join(tmpdir(),'workspace-scope-restore-')));folders.push(folder);
  const primary=join(folder,'primary'),secondary=join(folder,'secondary');mkdirSync(primary);mkdirSync(secondary);
  const store=new ProjectStore({file:join(folder,'projects.json'),recentsFile:join(folder,'recents.json'),migrationMarkerFile:join(folder,'migration.json'),sessionIndex:new SessionCwdIndex({sessionsRoot:join(folder,'sessions')}),noRepoPath:join(folder,'no-repo'),resolveProjectRoot:(cwd:string)=>cwd});
  const project=await store.createFromPath(primary);await store.addRoot(project.id,secondary);
  const resolveScope=createDesktopPanelProjectScopeResolver({store,environmentDir:join(folder,'environment')});
  const one=await resolveScope(primary,primary),two=await resolveScope(secondary,secondary);
  expect(one?.scope.projectId).toBe(project.id);expect(two?.scope.projectId).toBe(project.id);
  expect(one?.scope.rootId).not.toBe(two?.scope.rootId);
  await expect(resolveScope(primary,secondary)).rejects.toThrow('Panel execution root is outside its registered project');
  await store.remove(project.id);
  expect(() => one!.assertCurrent()).toThrow('Panel project scope changed; reopen the panel');
  expect(await resolveScope(primary,primary)).toBeUndefined();
  const restored=await store.createFromPath(primary);expect(restored.id).toBe(project.id);
  expect(() => one!.assertCurrent()).toThrow('Panel project scope was revoked; reopen the panel');
  const fresh=await resolveScope(primary,primary);fresh!.assertCurrent();
  expect(fresh?.scope).toEqual(one?.scope); // stable context identity is not a reusable authorization grant
});
