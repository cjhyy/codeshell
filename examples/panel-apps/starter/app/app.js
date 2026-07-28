const workspace = document.querySelector("#workspace");
const status = document.querySelector("#status");
const count = document.querySelector("#count");
const increment = document.querySelector("#increment");

let clicks = 0;

function renderContext(context) {
  workspace.textContent = context?.cwd || "未绑定项目";
  status.textContent = context?.trusted ? "可信工作区" : "只读上下文";
  status.dataset.ready = "true";
}

increment.addEventListener("click", () => {
  clicks += 1;
  count.textContent = `${clicks} 次点击`;
});

try {
  renderContext(await window.codeshellPanel.getContext());
  window.codeshellPanel.on("context.changed", renderContext);
} catch {
  renderContext({ cwd: "浏览器预览", trusted: false });
}
