import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from "electron";
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { LAB_QUERY_TYPES, type LabAuthorizationInput } from "../shared/optimization-lab.js";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const queryTypes = new Set<string>(LAB_QUERY_TYPES);
const forbidden = new Set(["cwd", "type", "projectTrusted", "confirmed", "authorized"]);

interface Deps {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  windows(): BrowserWindow[];
  enabled(): boolean;
  resolveTarget(target: unknown): Promise<{ kind: string; cwd: string }>;
  trusted(cwd: string): Promise<boolean>;
  query(type: string, params: Record<string, unknown>): Promise<any>;
  skills(cwd: string): unknown[];
  confirm(window: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>;
  save(window: BrowserWindow, name: string): Promise<string | undefined>;
  choose(window: BrowserWindow): Promise<string | undefined>;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid Lab input");
  const value = input as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_BYTES)
    throw new Error("Lab input is too large");
  for (const key of Object.keys(value))
    if (forbidden.has(key)) throw new Error(`Lab input cannot contain ${key}`);
  return value;
}

function identity(input: Record<string, unknown>): void {
  if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id))
    throw new Error("Invalid experiment ID");
}

function revision(input: Record<string, unknown>): void {
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)
    throw new Error("Invalid experiment revision");
}

/** The dialog describes the immutable plan read from the worker, never a renderer summary. */
export function authorizationMessage(snapshot: any, input: LabAuthorizationInput): string {
  const plan = snapshot.plan;
  if (
    !plan ||
    snapshot.id !== input.id ||
    plan.planHash !== input.planHash ||
    snapshot.state?.revision !== input.expectedRevision
  ) {
    throw new Error("Experiment changed; refresh the frozen plan before authorizing");
  }
  const connections = plan.connections ?? {};
  const describeConnection = (role: string) => {
    const connection = connections[role] ?? {};
    return `${connection.connectionId ?? "?"} / ${connection.modelId ?? "?"} (${connection.providerKind ?? "?"})\n${connection.endpoint ?? "?"}\nConfiguration hash: ${connection.configHash ?? "?"}`;
  };
  const operations = [plan.bounds?.trial, plan.bounds?.optimization];
  const bounded =
    Object.values(connections).every(
      (connection: any) => connection.outputCapCoversReasoning === true,
    ) && operations.every((operation) => operation?.inputTokenUpperBound != null);
  const tokenBound = bounded
    ? Math.max(
        ...operations.map(
          (operation) => operation.inputTokenUpperBound + operation.maxOutputTokens,
        ),
      ) * input.limits.maxRequests
    : null;
  return [
    `Experiment / 实验: ${input.id}`,
    `Plan hash / 计划哈希: ${input.planHash}`,
    `Skill: ${plan.skill?.name ?? "?"}\nRevision / 修订: ${plan.skill?.revision ?? "?"}`,
    `Target model / 目标模型: ${describeConnection("target")}`,
    `Optimizer / 优化模型: ${describeConnection("optimizer")}`,
    `Dataset hash / 样本哈希: ${plan.datasetHash ?? "?"}\nCounts / 数量: ${JSON.stringify(snapshot.datasetSummary ?? "see reviewed frozen dataset / 见已审核冻结样本")}`,
    `External data / 外发数据: ${JSON.stringify(plan.externalData)}\nTarget receives Skill and current case input; optimizer receives Skill and development feedback; holdout never enters optimizer; grading stays local. / 目标模型接收正文和当前题，优化模型接收正文和开发反馈，保留题不进入优化模型，本地人工评分。`,
    `Output limits / 输出限制: ${JSON.stringify(plan.bounds)}\nFinal evaluation allocation / 最终验收预留: ${JSON.stringify(plan.finalAllocation)}`,
    `Request limit / 请求上限: ${input.limits.maxRequests}`,
    `Execution time limit / 执行时间上限: ${input.limits.maxExecutionMs} ms`,
    `Worst-case Tokens / Token 最坏上界: ${tokenBound ?? "unknown / 无法保证上界"}\nWorst-case USD / 费用最坏上界: ${snapshot.estimate?.worstCaseCostUsd ?? "unknown / 无法保证上界"}`,
    `Token stop threshold / Token 停止阈值: ${input.limits.maxEstimatedTokens ?? "unknown / 未设定"}`,
    `Estimated USD stop threshold / 估算费用停止阈值: ${input.limits.maxEstimatedCostUsd ?? "unknown / 未设定"}`,
    `Expires / 授权到期: ${input.expiresAt}`,
    "Token and fee thresholds are estimates, not a provider billing cap. Unknown usage remains charged against the experiment. / Token 与费用阈值不是供应商账单硬封顶，未知用量会保守保留。",
    "This authorizes only this experiment. Candidates do not become active Skills. / 仅授权本次实验，候选不会自动成为生效 Skill。",
  ].join("\n\n");
}

/** Local top-frame bridge; no raw worker grant is exposed through preload or Web. */
export function registerOptimizationLabIpc(deps: Deps): () => void {
  const channels: string[] = [];
  const owner = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = deps.windows().find((w) => !w.isDestroyed() && w.webContents === event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Lab requires an application top frame");
    if (!deps.enabled()) throw new Error("Optimization Lab is disabled");
    return window;
  };
  const resolve = async (
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> & { cwd: string }> => {
    const target = await deps.resolveTarget(input.target);
    if (target.kind !== "project" || !(await deps.trusted(target.cwd)))
      throw new Error("Lab requires a trusted tracked project");
    const { target: _target, ...params } = input;
    return { ...params, cwd: target.cwd };
  };
  const handle = (
    channel: string,
    handler: (window: BrowserWindow, args: unknown[]) => Promise<unknown>,
  ) => {
    channels.push(channel);
    deps.ipc.handle(channel, (event, ...args) => handler(owner(event), args));
  };
  handle("optimizationLab:query", async (_window, args) => {
    if (args.length !== 2 || typeof args[0] !== "string" || !queryTypes.has(args[0]))
      throw new Error("Unsupported Lab query");
    const input = record(args[1]);
    const params = await resolve(input);
    const result = await deps.query(`optimization_lab_${args[0]}`, params);
    return args[0] === "discover" ? { ...result, skills: deps.skills(params.cwd) } : result;
  });
  handle("optimizationLab:authorize", async (window, args) => {
    if (args.length !== 1) throw new Error("Invalid Lab authorization");
    const input = record(args[0]);
    identity(input);
    revision(input);
    if (
      typeof input.planHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.planHash) ||
      typeof input.operationId !== "string" ||
      input.operationId.length < 1 ||
      input.operationId.length > 128 ||
      typeof input.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= Date.now()
    )
      throw new Error("Invalid Lab authorization");
    const limits = input.limits as Record<string, unknown> | undefined;
    if (
      !limits ||
      typeof limits !== "object" ||
      Array.isArray(limits) ||
      Object.keys(limits).some(
        (key) =>
          !["maxRequests", "maxExecutionMs", "maxEstimatedTokens", "maxEstimatedCostUsd"].includes(
            key,
          ),
      )
    )
      throw new Error("Invalid Lab limits");
    for (const key of ["maxRequests", "maxExecutionMs"])
      if (!Number.isSafeInteger(limits[key]) || Number(limits[key]) <= 0)
        throw new Error("Invalid Lab limits");
    for (const key of ["maxEstimatedTokens", "maxEstimatedCostUsd"])
      if (
        limits[key] != null &&
        (typeof limits[key] !== "number" ||
          !Number.isFinite(limits[key]) ||
          Number(limits[key]) <= 0)
      )
        throw new Error("Invalid Lab limits");
    const params = await resolve(input);
    const snapshot = await deps.query("optimization_lab_get", { cwd: params.cwd, id: params.id });
    const message = authorizationMessage(snapshot, input as unknown as LabAuthorizationInput);
    const confirmation = await deps.confirm(window, {
      type: "question",
      title: "Optimization Lab / 优化实验室",
      message: "Authorize this frozen experiment? / 授权这个冻结实验？",
      detail: message,
      buttons: ["Cancel / 取消", "Authorize / 授权"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return null;
    // Re-resolve mounted primary, trust and flag after a potentially long native dialog.
    if (window.isDestroyed() || !deps.enabled())
      throw new Error("Lab authorization is no longer available");
    const current = await resolve(input);
    if (current.cwd !== params.cwd) throw new Error("Project primary changed during authorization");
    authorizationMessage(
      await deps.query("optimization_lab_get", { cwd: params.cwd, id: params.id }),
      input as unknown as LabAuthorizationInput,
    );
    return deps.query("optimization_lab_grant", params);
  });
  handle("optimizationLab:exportFile", async (window, args) => {
    if (args.length !== 1) throw new Error("Invalid Lab export");
    const input = record(args[0]);
    identity(input);
    if (!["grading", "report-json", "report-markdown"].includes(String(input.kind)))
      throw new Error("Invalid export kind");
    const params = await resolve(input);
    const grading = input.kind === "grading";
    const artifact = await deps.query(
      grading ? "optimization_lab_export_grading" : "optimization_lab_report",
      { cwd: params.cwd, id: input.id },
    );
    const markdown = input.kind === "report-markdown";
    const content = markdown
      ? artifact.markdown
      : JSON.stringify(grading ? artifact : artifact.json, null, 2);
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_JSON_BYTES)
      throw new Error("Invalid report artifact");
    const destination = await deps.save(
      window,
      `optimization-${input.id}-${String(input.kind)}.${markdown ? "md" : "json"}`,
    );
    if (!destination) return false;
    await writeFile(destination, content, { encoding: "utf8", mode: 0o600 });
    return true;
  });
  handle("optimizationLab:importGrading", async (window, args) => {
    if (args.length !== 1) throw new Error("Invalid grading import");
    const input = record(args[0]);
    identity(input);
    revision(input);
    const params = await resolve(input);
    const source = await deps.choose(window);
    if (!source) return null;
    const prior = await lstat(source);
    if (!prior.isFile() || prior.isSymbolicLink() || prior.size > MAX_JSON_BYTES)
      throw new Error("Grading file must be a bounded regular JSON file");
    const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.dev !== prior.dev ||
        info.ino !== prior.ino ||
        info.size > MAX_JSON_BYTES
      )
        throw new Error("Grading file must be a bounded regular JSON file");
      const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_JSON_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > info.size || length > MAX_JSON_BYTES)
        throw new Error("Grading JSON changed or is too large");
      const grading = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (!deps.enabled()) throw new Error("Optimization Lab is disabled");
      const current = await resolve(input);
      if (current.cwd !== params.cwd) throw new Error("Project primary changed during import");
      return deps.query("optimization_lab_import_grading", {
        cwd: params.cwd,
        id: params.id,
        expectedRevision: input.expectedRevision,
        grading,
      });
    } finally {
      await file.close();
    }
  });
  return () => {
    for (const channel of channels) deps.ipc.removeHandler(channel);
  };
}
