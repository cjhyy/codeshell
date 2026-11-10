import type { BuiltinQueryHandler } from "./context.js";
import {
  queryModels,
  queryProviders,
  queryProviderAdd,
  queryProviderRefresh,
  queryProviderDelete,
  queryModelAdd,
  queryModelDelete,
} from "./models.js";
import { queryConfig, queryConfigSet, queryConfigGet, queryPermissionSet } from "./settings.js";
import {
  queryOutputJournal,
  querySessions,
  querySessionDetail,
  queryCompact,
  queryArchiveRange,
  queryArchiveMarker,
} from "./sessions.js";
import { queryUsage, queryTools } from "./usage-tools.js";

/** Map lookup never treats Object.prototype names as built-in queries. */
export const builtinQueryHandlers: ReadonlyMap<string, BuiltinQueryHandler> = new Map<
  string,
  BuiltinQueryHandler
>([
  ["models", queryModels],
  ["providers", queryProviders],
  ["provider_add", queryProviderAdd],
  ["provider_refresh", queryProviderRefresh],
  ["provider_delete", queryProviderDelete],
  ["model_add", queryModelAdd],
  ["model_delete", queryModelDelete],
  ["config", queryConfig],
  ["config_set", queryConfigSet],
  ["config_get", queryConfigGet],
  ["permission_set", queryPermissionSet],
  ["output_journal", queryOutputJournal],
  ["sessions", querySessions],
  ["session_detail", querySessionDetail],
  ["compact", queryCompact],
  ["archive_range", queryArchiveRange],
  ["archive_marker", queryArchiveMarker],
  ["usage", queryUsage],
  ["tools", queryTools],
]);
