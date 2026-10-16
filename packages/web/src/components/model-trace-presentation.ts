import type {
  ModelTraceAttempt,
  ModelTraceCallType,
  ModelTraceEvent,
  ModelTraceRecord,
} from "../model-trace-api.js";
export type { ModelTraceCallType } from "../model-trace-api.js";

export const modelTraceCallTypes = [
  "execution",
  "task",
  "panel",
  "summary",
  "context",
  "title",
  "goal",
  "memory",
  "suggestion",
  "speech",
  "transcription",
  "audio",
  "external",
  "other",
] as const satisfies ReadonlyArray<ModelTraceCallType>;

const callTypes = {
  zh: {
    execution: ["运行 Prompt", "会话执行时组装的模型输入"],
    task: ["子任务 Prompt", "委派给子任务的模型输入"],
    panel: ["Panel 调用", "由 Panel 发起的模型调用"],
    summary: ["摘要 / 压缩 Prompt", "生成摘要或压缩会话历史"],
    context: ["上下文整理 Prompt", "整理本次执行所需的上下文"],
    title: ["标题生成 Prompt", "生成会话或任务标题"],
    goal: ["目标检查 Prompt", "检查目标的进展与完成情况"],
    memory: ["记忆整理 Prompt", "提取、整理或更新记忆"],
    suggestion: ["后续建议 Prompt", "生成会话的后续操作建议"],
    speech: ["语音合成", "将文本转换为语音"],
    transcription: ["语音转写", "将语音转换为文字"],
    audio: ["音频处理", "对音频执行模型推理"],
    external: ["外部 CLI 入口", "提交给外部 CLI 的入口输入"],
    other: ["其他调用", "调用未提供可识别的类型"],
  },
  en: {
    execution: ["Execution Prompt", "Model input assembled for a session execution"],
    task: ["Subtask Prompt", "Model input for a delegated task"],
    panel: ["Panel call", "A model call initiated by a Panel"],
    summary: ["Summary and compaction Prompt", "Summarize or compact session history"],
    context: ["Context preparation Prompt", "Prepare context for an execution"],
    title: ["Title generation Prompt", "Generate a session or task title"],
    goal: ["Goal check Prompt", "Check progress toward a goal"],
    memory: ["Memory maintenance Prompt", "Extract, organize or update memory"],
    suggestion: ["Follow-up suggestion Prompt", "Suggest next steps for a session"],
    speech: ["Speech synthesis", "Convert text to speech"],
    transcription: ["Speech transcription", "Convert speech to text"],
    audio: ["Audio processing", "Run model inference on audio"],
    external: ["External CLI entry", "Input submitted to an external CLI"],
    other: ["Other call", "The call has no recognized type"],
  },
} as const;

/** Classification belongs to the Host; clients never guess intent from Prompt text. */
export function presentModelTraceCallType(value: unknown, lang: "zh" | "en") {
  const type = modelTraceCallTypes.includes(value as ModelTraceCallType)
    ? (value as ModelTraceCallType)
    : "other";
  const [label, description] = callTypes[lang][type];
  return { type, label, description };
}

/** The record keeps a logical snapshot even when a transport attempt contains provider wire. */
export function modelTraceInputBoundary(
  kind: "request" | "attempt" | "event",
  selected: ModelTraceRecord | ModelTraceAttempt | ModelTraceEvent,
  record: ModelTraceRecord,
): "logical" | "wire" | "external" | "media" | "event" {
  if (kind === "event") return "event";
  const attempt = kind === "attempt" ? (selected as ModelTraceAttempt) : undefined;
  if (attempt?.coverage === "provider-wire") return "wire";
  if (
    attempt?.coverage === "external-cli-input" ||
    (kind === "request" && record.attempts.some((item) => item.coverage === "external-cli-input"))
  )
    return "external";
  const type = presentModelTraceCallType(record.callType, "en").type;
  if (type === "speech" || type === "transcription" || type === "audio") return "media";
  return "logical";
}
