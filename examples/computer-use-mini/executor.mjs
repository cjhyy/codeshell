import { createInterface } from "node:readline";

// This separate process owns the simulated app. Resetting the JS runtime cannot reset it.
const calculator = { open: false, expression: "", result: null, revision: 0 };
const labels = [..."0123456789", "+", "=", "C"];

function execute(method, params) {
  if (method === "app.open") {
    if (!["Calculator", "计算器"].includes(params.name)) {
      throw new Error("This demo only provides Calculator");
    }
    calculator.open = true;
    return { appId: "calculator" };
  }

  if (params.appId !== "calculator" || !calculator.open) {
    throw new Error("Open Calculator with cua.getApp() first");
  }

  if (method === "app.getState") {
    return {
      appId: "calculator",
      display: String(calculator.result ?? (calculator.expression || "0")),
      expression: calculator.expression,
      result: calculator.result,
      revision: calculator.revision,
      elements: labels.map((name) => ({ id: `button:${name}`, role: "button", name })),
    };
  }

  if (method !== "app.click") throw new Error(`Unknown method: ${method}`);
  const label = labels.find((name) => params.elementId === `button:${name}`);
  if (!label) throw new Error(`Unknown element: ${params.elementId}`);

  if (label === "C") {
    calculator.expression = "";
    calculator.result = null;
  } else if (label === "=") {
    if (!/^\d+\+\d+$/.test(calculator.expression)) {
      throw new Error("Enter two nonnegative integers separated by +, then click =");
    }
    const [a, b] = calculator.expression.split("+").map(Number);
    if (![a, b, a + b].every(Number.isSafeInteger)) {
      throw new Error("The numbers exceed JavaScript's safe integer range");
    }
    calculator.result = a + b;
  } else {
    let expression = calculator.expression;
    if (calculator.result !== null) {
      expression = label === "+" ? String(calculator.result) : "";
    }
    if (expression.length >= 64) throw new Error("Expression is too long; click C to clear");
    if (label === "+" && (!expression || expression.includes("+"))) {
      throw new Error("This demo supports one addition at a time");
    }
    calculator.expression = expression + label;
    calculator.result = null;
  }

  calculator.revision += 1;
  return { ok: true, revision: calculator.revision };
}

// stdout is exclusively the JSON-RPC wire; diagnostics belong on stderr.
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  let response;
  try {
    request = JSON.parse(line);
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      throw new Error("Expected a JSON-RPC 2.0 request");
    }
    const result = execute(request.method, request.params ?? {});
    response = { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    response = {
      jsonrpc: "2.0",
      id: request?.id ?? null,
      error: { code: -32000, message: error.message },
    };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
