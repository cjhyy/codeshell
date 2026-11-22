import { expect, test } from "bun:test";
import { scopedConfigurationReads } from "./scoped-configuration-reads.js";
import { HostRevokedError } from "./authority.js";
import { InvalidParams } from "./server.js";

const worker = { view: async (): Promise<never> => { throw Error("Unexpected worker read"); } };

test("configuration targets derive session authority from one stable identity", () => {
  const methods = new Map(scopedConfigurationReads(async () => ({ sessions: [], nextCursor: null }), worker));
  const list = methods.get("skills/list")!;
  expect(list.optionalSessionId?.({target:null})).toBeUndefined();
  expect(list.optionalSessionId?.({target:{projectId:"proj-id"}})).toBeUndefined();
  expect(list.optionalSessionId?.({target:{sessionId:"one"}})).toBe("one");
  for (const target of [{cwd:"/tmp"}, {projectId:"p",sessionId:"s"}, {sessionId:"../s"}])
    expect(() => list.optionalSessionId?.({target})).toThrow(InvalidParams);
});

test("unowned configuration requests must reference currently visible history", async () => {
  const lookedUp:string[] = [];
  const methods = new Map(scopedConfigurationReads(async opts => {
    lookedUp.push(String(opts.sessionId)); return {sessions:[],nextCursor:null};
  }, worker));
  const ctx = { identity:{webContentsId:1,frameToken:"doc",frameGeneration:1,windowKind:"workbench" as const},historical:true,assertCurrent(){} };
  await expect(methods.get("settings/project")!.run(ctx,{target:{sessionId:"hidden"}})).rejects.toThrow(HostRevokedError);
  await expect(methods.get("agents/body")!.run(ctx,{target:{sessionId:"hidden"},filePath:"role.md"})).rejects.toThrow(HostRevokedError);
  expect(lookedUp).toEqual(["hidden", "hidden"]);
});
