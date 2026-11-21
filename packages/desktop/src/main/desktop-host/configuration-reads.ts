import { catalogEntryOrigins, getMergedCatalog } from "@cjhyy/code-shell-core/internal";
import { listPluginMcpTrust } from "@cjhyy/code-shell-core";
import { getProjectStore } from "../project-store.js";
import {
  requireRendererProjectPath,
  requireRendererProjectPrimary,
} from "../renderer-project-path.js";
import { getTrust, summarizeProjectTrustRisks } from "../trust-store.js";
import { loadRecents } from "../recents-store.js";
import { readSettings } from "../settings-service.js";
import { catalogList, listScopes, workspaceAccess } from "../sources-service.js";
import { getPluginMedia } from "../plugin-media-service.js";
import { getPluginDetail } from "../plugins-service.js";
import { InvalidParams } from "./server.js";
import {
  businessRead,
  noBusinessArguments,
  businessArguments,
  textArgument,
} from "./business-read.js";

function projectPath(input: unknown) {
  return { path: textArgument(businessArguments(input, ["path"]).path) };
}

export const configurationReads = [
  businessRead("projects/list", noBusinessArguments, () => getProjectStore().list()),
  businessRead("projects/recents", noBusinessArguments, () => loadRecents()),
  businessRead("projects/trust", projectPath, async ({ path }) =>
    getTrust(await requireRendererProjectPath(path)),
  ),
  businessRead("projects/trustRisks", projectPath, async ({ path }) =>
    summarizeProjectTrustRisks(await requireRendererProjectPath(path)),
  ),
  businessRead(
    "settings/user",
    (input) => {
      if (businessArguments(input, ["scope"]).scope !== "user")
        throw new InvalidParams("Expected user settings scope");
      return { scope: "user" as const };
    },
    () => readSettings("user"),
  ),
  businessRead("sources/catalog", noBusinessArguments, catalogList),
  businessRead(
    "sources/projectAccess",
    (input) => ({ projectId: textArgument(businessArguments(input, ["projectId"]).projectId) }),
    async ({ projectId }) => workspaceAccess((await requireRendererProjectPrimary(projectId)).path),
  ),
  businessRead(
    "sources/scopes",
    (input) => ({ sourceId: textArgument(businessArguments(input, ["sourceId"]).sourceId) }),
    ({ sourceId }) => listScopes(sourceId),
  ),
  businessRead(
    "plugins/detail",
    (input) => ({ installKey: textArgument(businessArguments(input, ["installKey"]).installKey) }),
    ({ installKey }) => getPluginDetail(installKey),
  ),
  businessRead(
    "plugins/media",
    (input) => {
      const { installKey, includeScreenshots } = businessArguments(input, [
        "installKey",
        "includeScreenshots",
      ]);
      if (includeScreenshots !== undefined && typeof includeScreenshots !== "boolean")
        throw new InvalidParams();
      return { installKey: textArgument(installKey), includeScreenshots };
    },
    ({ installKey, includeScreenshots }) => getPluginMedia(installKey, includeScreenshots === true),
  ),
  businessRead("mcp/pluginTrust", noBusinessArguments, () => listPluginMcpTrust()),
  businessRead("models/catalog", noBusinessArguments, getMergedCatalog),
  businessRead("models/catalogOrigins", noBusinessArguments, catalogEntryOrigins),
];
