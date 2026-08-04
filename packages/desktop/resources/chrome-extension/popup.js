const statusNode = document.getElementById("status");
const requestsNode = document.getElementById("requests");
const refreshButton = document.getElementById("refresh");

async function loadRequests() {
  statusNode.className = "";
  statusNode.textContent = "正在连接 CodeShell…";
  requestsNode.replaceChildren();
  try {
    const result = await chrome.runtime.sendMessage({ type: "pairing.list" });
    const requests = Array.isArray(result?.requests) ? result.requests : [];
    statusNode.textContent = requests.length
      ? "请选择要接收当前 Chrome 标签的任务："
      : "CodeShell 已连接，但目前没有等待中的配对请求。";
    for (const request of requests) requestsNode.appendChild(requestCard(request));
  } catch (error) {
    statusNode.className = "error";
    statusNode.textContent = `无法连接 CodeShell：${error instanceof Error ? error.message : String(error)}`;
  }
}

function requestCard(request) {
  const card = document.createElement("div");
  card.className = "request";
  const title = document.createElement("strong");
  title.textContent = request.label || "CodeShell 任务";
  const code = document.createElement("code");
  code.textContent = `配对码 ${request.code}`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "授权当前标签";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "pairing.grant", code: request.code });
      statusNode.textContent = "授权成功。你可以返回 CodeShell。";
      requestsNode.replaceChildren();
    } catch (error) {
      button.disabled = false;
      statusNode.className = "error";
      statusNode.textContent = `授权失败：${error instanceof Error ? error.message : String(error)}`;
    }
  });
  card.append(title, code, button);
  return card;
}

refreshButton.addEventListener("click", () => void loadRequests());
void loadRequests();
