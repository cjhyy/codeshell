import type { BuiltinQueryContext } from "./context.js";
import {
  createResponse,
  createErrorResponse,
  ErrorCodes,
  type RpcRequest,
  type QueryParams,
} from "../types.js";
import type { EngineConfig } from "../../engine/engine.js";
import { isProtectedSettingKey } from "../../settings/manager.js";
import { maskSecretValue } from "../redact.js";
import { configQueryData } from "../config-query.js";

export async function queryConfig(
  context: Pick<BuiltinQueryContext, "engine" | "resolveEngine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  const configEngine = await context.resolveEngine(req, params.sessionId, engine, "config");
  if (!configEngine) return;
  context.send(createResponse(req.id, { type: "config", data: configQueryData(configEngine) }));
  return;
}

export async function queryConfigSet(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for config_set"),
    );
    return;
  }
  try {
    const { key, value } = params;
    if (!key) throw new Error("key is required for config_set");
    // Refuse writes to trust-root fields via the generic config path. A
    // protocol peer (external driver, paired phone, compromised renderer)
    // could otherwise self-authorize tools or inject env/hooks/MCP servers,
    // which is equivalent to remotely bypassing workspace trust. Legit
    // writes to these go through the dedicated settings UI, not config_set;
    // provider/model edits use provider_add / models handlers below.
    if (isProtectedSettingKey(key)) {
      throw new Error(
        `config_set refused: "${key}" is a protected trust/permission field and cannot be written through this path.`,
      );
    }
    engine.updateConfig(key, value);
    // Echo back through the same secret-aware masker as config_get so
    // a `config_set("llm.apiKey", "...")` confirmation doesn't ship
    // the new secret through the response/log path.
    const safeValue = maskSecretValue(key, value);
    context.send(createResponse(req.id, { type: "config_set", data: { key, value: safeValue } }));
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryConfigGet(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for config_get"),
    );
    return;
  }
  try {
    const { key } = params;
    if (!key) throw new Error("key is required for config_get");
    const value = engine.readSetting(key);
    // Mask secret-looking keys (apiKey/token/secret/…) at the boundary.
    const safeValue = maskSecretValue(key, value);
    context.send(createResponse(req.id, { type: "config_get", data: { key, value: safeValue } }));
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryPermissionSet(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InternalError,
        "No engine available for permission_set",
      ),
    );
    return;
  }
  try {
    const value = params.value as string | undefined;
    const valid = ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan"];
    if (!value || !valid.includes(value)) {
      throw new Error(`invalid permission mode: ${value}`);
    }
    engine.setPermissionMode(value as NonNullable<EngineConfig["permissionMode"]>);
    context.send(
      createResponse(req.id, {
        type: "permission_set",
        data: { mode: value },
      }),
    );
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}
