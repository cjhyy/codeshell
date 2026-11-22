import { expect, mock, test } from "bun:test";
import { createConfigurationReads } from "./configuration-reads.js";
import { configurationReads } from "../main/desktop-host/configuration-reads.js";
import { InvalidParams } from "../main/desktop-host/server.js";
import type { HostRequestContext } from "../main/desktop-host/authority.js";

test("plugin media reaches the Host with the installation identity and screenshot option", async () => {
  const handler = new Map(configurationReads).get("plugins/media")!;
  const invoke = mock();
  const readBusiness = mock(async (method: string, params: unknown): Promise<never> => {
    expect(method).toBe("plugins/media");
    expect(params).toEqual({ installKey: "sample", includeScreenshots: true });
    // Exercise the registered parser without loading any installed media.
    return handler.run({} as HostRequestContext, {
      ...(params as object),
      includeScreenshots: "yes",
    }) as never;
  });
  const api = createConfigurationReads({ invoke }, { readBusiness });
  await expect(api.getPluginMedia("sample", true)).rejects.toBeInstanceOf(InvalidParams);
  expect(readBusiness).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
});
