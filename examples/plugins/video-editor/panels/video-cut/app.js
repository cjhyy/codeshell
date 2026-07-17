/* global document, navigator, window */

const fields = {
  input: document.querySelector("#input"),
  output: document.querySelector("#output"),
  aspect: document.querySelector("#aspect"),
  fit: document.querySelector("#fit"),
  transition: document.querySelector("#transition"),
  transitionDuration: document.querySelector("#transitionDuration"),
  clips: document.querySelector("#clips"),
  subtitles: document.querySelector("#subtitles"),
  notes: document.querySelector("#notes"),
};
const planView = document.querySelector("#plan");
const submit = document.querySelector("#submit");
const copy = document.querySelector("#copy");
const status = document.querySelector("#status");
let contextBusy = false;
let submitting = false;
let saveTimer;

function clipLines() {
  return fields.clips.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?)\s*(?:-|→|—)\s*(.+)$/);
      return match ? { start: match[1].trim(), end: match[2].trim() } : { range: line };
    });
}

function draftPlan() {
  const plan = {
    input: fields.input.value.trim(),
    output: fields.output.value.trim(),
    overwrite: false,
    clips: clipLines(),
    video: {
      aspect: fields.aspect.value,
      fit: fields.fit.value,
      transition:
        fields.transition.value === "fade"
          ? {
              type: "fade",
              duration: Number(fields.transitionDuration.value),
            }
          : { type: "cut" },
    },
    audio: {
      mute: false,
      volume: 1,
    },
  };
  const subtitles = fields.subtitles.value.trim();
  if (subtitles) plan.subtitles = { path: subtitles };
  return plan;
}

function renderPlan() {
  planView.textContent = JSON.stringify(draftPlan(), null, 2);
}

async function saveState() {
  const value = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, field.value]),
  );
  await window.codeshellPanel.call("storage.set", { key: "draft", value });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveState().catch(() => undefined);
  }, 300);
}

async function loadState() {
  const saved = await window.codeshellPanel.call("storage.get", { key: "draft" });
  if (!saved || typeof saved !== "object") return;
  for (const [key, value] of Object.entries(saved)) {
    if (fields[key] && typeof value === "string") fields[key].value = value;
  }
}

function setStatus(message, kind = "idle") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function updateSubmitState() {
  submit.disabled = contextBusy || submitting;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    return copied;
  }
}

for (const field of Object.values(fields)) {
  field.addEventListener("input", () => {
    renderPlan();
    scheduleSave();
  });
  field.addEventListener("change", () => {
    renderPlan();
    scheduleSave();
  });
}

copy.addEventListener("click", async () => {
  if (await copyText(JSON.stringify(draftPlan(), null, 2))) {
    setStatus("已复制", "ok");
  } else {
    setStatus("复制失败", "error");
  }
});

submit.addEventListener("click", async () => {
  const plan = draftPlan();
  if (!plan.input || !plan.output) {
    setStatus("请填写输入和输出", "error");
    return;
  }
  if (plan.clips.some((clip) => "range" in clip)) {
    setStatus("片段格式应为 起点 - 终点", "error");
    return;
  }
  if (
    plan.video.transition.type === "fade" &&
    (!Number.isFinite(plan.video.transition.duration) ||
      plan.video.transition.duration < 0.01 ||
      plan.video.transition.duration > 5)
  ) {
    setStatus("转场时长应在 0.01 到 5 秒之间", "error");
    return;
  }

  submitting = true;
  updateSubmitState();
  setStatus("正在提交…");
  try {
    await saveState();
    const notes = fields.notes.value.trim();
    const prompt = [
      "请使用 video-editor skill 处理下面的视频剪辑请求。",
      "先 check/probe，创建可复现的 edit plan，运行 --dry-run 并总结后向我确认；不要直接覆盖或渲染。",
      "",
      "Draft plan:",
      "```json",
      JSON.stringify(plan, null, 2),
      "```",
      notes ? `额外要求：${notes}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await window.codeshellPanel.call("agent.submitPrompt", { prompt });
    setStatus("已提交", "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "提交失败", "error");
  } finally {
    submitting = false;
    updateSubmitState();
  }
});

window.codeshellPanel.on("context.changed", (context) => {
  contextBusy = Boolean(context?.busy);
  updateSubmitState();
  if (contextBusy) {
    setStatus("会话忙碌中");
  } else if (!submitting) {
    setStatus("准备就绪");
  }
});

void loadState()
  .catch(() => undefined)
  .finally(() => {
    renderPlan();
    updateSubmitState();
  });
