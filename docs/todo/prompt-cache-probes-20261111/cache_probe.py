"""Prompt-cache probe: does mutating top-level tools bust the cache, and does
append-only discovery keep it? Synthetic payloads only. Prints usage, never keys."""
import json, os, random, sys, time, urllib.request, urllib.error, uuid
from concurrent.futures import ThreadPoolExecutor

S = json.load(open(os.path.expanduser("~/.code-shell/settings.json")))
CRED = {c["id"]: c for c in S["credentials"]}
OR_KEY = CRED["openrouter-key"]["apiKey"]
DS = CRED["deepseek-key"]
OR = "https://openrouter.ai/api/v1"

WORDS = ("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho "
         "sigma tau upsilon phi chi psi omega river stone cloud ember quartz meadow harbor lantern").split()


def filler(nonce, n_words=4200):
    rnd = random.Random(nonce)
    lines = [f"Rule {i}: when handling item {rnd.randint(1000,9999)}, keep answers short, cite the {rnd.choice(WORDS)} checklist, and confirm the result with the user." for i in range(n_words // 22)]
    return f"[session {nonce}] Team style guide for a helpful assistant.\n" + "\n".join(lines)


def fn(name, desc, props, required):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}}


BASE_TOOLS = [
    fn("Read", "Read a file from disk.", {"path": {"type": "string"}}, ["path"]),
    fn("Bash", "Run a shell command.", {"command": {"type": "string"}}, ["command"]),
    fn("ToolSearch", "Find additional tools. Use select:Name to load a tool schema.",
       {"query": {"type": "string"}}, ["query"]),
    fn("CallTool", "Call a tool whose schema was returned by ToolSearch.",
       {"name": {"type": "string"}, "args": {"type": "object"}}, ["name", "args"]),
]
WEATHER = fn("get_weather", "Get current weather for a city.",
             {"city": {"type": "string"}, "unit": {"type": "string", "enum": ["c", "f"]}}, ["city"])


def post(url, key, body, extra_headers=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json", **(extra_headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:400]}
    except Exception as e:  # noqa
        return {"http_error": -1, "body": repr(e)[:300]}


def summarize(resp):
    if "http_error" in resp or "error" in resp:
        return {"error": json.dumps(resp, ensure_ascii=False)[:300]}
    u = resp.get("usage") or {}
    d = u.get("prompt_tokens_details") or {}
    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    calls = [(c["function"]["name"], c["function"]["arguments"][:80]) for c in (msg.get("tool_calls") or [])]
    return {"prompt": u.get("prompt_tokens"),
            "cached": d.get("cached_tokens", u.get("prompt_cache_hit_tokens")),
            "write": d.get("cache_write_tokens"), "provider": resp.get("provider"), "calls": calls, "text": (msg.get("content") or "")[:90]}


def mark(text, anthropic):
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}] if anthropic else text


def scenario(route, model, kind, base, key):
    """kind: 'top' = r3 appends a tool to top-level tools; 'append' = r3 appends discovery to history."""
    nonce = uuid.uuid4().hex[:12]
    anth = model.startswith(("anthropic/", "google/"))
    hist = kind.startswith("hist")
    sysmsg = {"role": "system", "content": mark(f"[session {nonce}] You are a terse assistant." if hist else filler(nonce), anth)}
    u1 = (filler(nonce) + "\n\n" if hist else "") + "Remember the manual above. Reply with the single word OK."
    u2 = "Reply with the single word OK again."
    u3 = "What is the weather in Paris? Use a tool."

    def run(msgs, tools, max_tokens=48):
        msgs = [dict(m) for m in msgs]
        if anth:  # rolling breakpoint on the final message, like CodeShell does
            last = msgs[-1]
            if isinstance(last.get("content"), str):
                last["content"] = mark(last["content"], True)
        body = {"model": model, "messages": msgs, "tools": tools, "max_tokens": max_tokens, "stream": False}
        if base == OR:
            body["session_id"] = nonce
        return summarize(post(f"{base}/chat/completions", key, body))

    out = []
    out.append(run([sysmsg, {"role": "user", "content": u1}], BASE_TOOLS))
    time.sleep(6)
    h2 = [sysmsg, {"role": "user", "content": u1}, {"role": "assistant", "content": "OK"},
          {"role": "user", "content": u2}]
    out.append(run(h2, BASE_TOOLS))
    time.sleep(6)
    h3 = h2 + [{"role": "assistant", "content": "OK"}, {"role": "user", "content": u3}]
    if kind in ("top", "hist-top"):
        out.append(run(h3, BASE_TOOLS + [WEATHER], 300))
    else:
        h3 = h3 + [
            {"role": "assistant", "content": None, "tool_calls": [{"id": "call_ts1", "type": "function",
             "function": {"name": "ToolSearch", "arguments": json.dumps({"query": "select:get_weather"})}}]},
            {"role": "tool", "tool_call_id": "call_ts1", "content":
             "Loaded tool. Invoke it with CallTool(name, args).\n" + json.dumps(WEATHER["function"])},
        ]
        out.append(run(h3, BASE_TOOLS, 300))
    return route, kind, out


def anthropic_native():
    """OpenRouter Anthropic-format endpoint: defer_loading + client tool_reference."""
    nonce = uuid.uuid4().hex[:12]
    model = "anthropic/claude-sonnet-5"
    def at(t, defer=False):
        f = t["function"]
        d = {"name": f["name"], "description": f["description"], "input_schema": f["parameters"]}
        if defer:
            d["defer_loading"] = True
        return d
    tools = [at(BASE_TOOLS[0]), at(BASE_TOOLS[1]), at(BASE_TOOLS[2]), at(WEATHER, True)]
    system = [{"type": "text", "text": filler(nonce), "cache_control": {"type": "ephemeral"}}]
    def cc(text):
        return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]
    def run(msgs, max_tokens=48):
        r = post(f"{OR}/messages", OR_KEY, {"model": model, "system": system, "tools": tools,
                 "messages": msgs, "max_tokens": max_tokens, "session_id": nonce},
                 {"anthropic-version": "2023-06-01"})
        if "usage" not in r:
            return {"error": json.dumps(r, ensure_ascii=False)[:400]}
        u = r["usage"]
        return {"input": u.get("input_tokens"), "cache_read": u.get("cache_read_input_tokens"),
                "cache_write": u.get("cache_creation_input_tokens"),
                "calls": [(b["name"], json.dumps(b["input"])[:80]) for b in r.get("content", []) if b["type"] == "tool_use"],
                "text": " ".join(b.get("text","") for b in r.get("content", []) if b["type"]=="text")[:160], "stop": r.get("stop_reason")}
    out = []
    h = [{"role": "user", "content": cc("List the exact names of every tool you can call right now, comma separated.")}]
    out.append(run(h, 120)); time.sleep(6)
    h = [{"role": "user", "content": "Remember the manual above. Reply with the single word OK."},
         {"role": "assistant", "content": "OK"},
         {"role": "user", "content": cc("Reply with the single word OK again.")}]
    out.append(run(h)); time.sleep(6)
    h = h[:2] + [{"role": "user", "content": "Reply with the single word OK again."},
         {"role": "assistant", "content": "OK"},
         {"role": "user", "content": "What is the weather in Paris? Use a tool."},
         {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_ts1", "name": "ToolSearch",
                                            "input": {"query": "select:get_weather"}}]},
         {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_ts1",
          "content": [{"type": "tool_reference", "tool_name": "get_weather"}],
          "cache_control": {"type": "ephemeral"}}]}]
    out.append(run(h, 300))
    return "or-messages:claude-sonnet-5", "native-ref", out


ROUTES = [
    ("or:claude-sonnet-5", "anthropic/claude-sonnet-5", OR, OR_KEY),
    ("or:gpt-5.6-luna", "openai/gpt-5.6-luna", OR, OR_KEY),
    ("or:gemini-3.8-flash", "google/gemini-3.8-flash", OR, OR_KEY),
    ("or:deepseek-v4-flash", "deepseek/deepseek-v4-flash", OR, OR_KEY),
    ("or:kimi-k2.7-code", "moonshotai/kimi-k2.7-code", OR, OR_KEY),
    ("or:glm-5.2", "z-ai/glm-5.2", OR, OR_KEY),
    ("or:grok-4.6", "x-ai/grok-4.6", OR, OR_KEY),
    ("direct:deepseek-v4-flash", "deepseek-v4-flash", DS["baseUrl"], DS["apiKey"]),
]
KINDS = sys.argv[1].split(","); only = sys.argv[2:]
jobs = []
with ThreadPoolExecutor(max_workers=20) as ex:
    for route, model, base, key in ROUTES:
        if only and not any(o in route for o in only):
            continue
        for kind in KINDS:
            jobs.append(ex.submit(scenario, route, model, kind, base, key))
    if "native" in only:
        jobs.append(ex.submit(anthropic_native))
    for j in jobs:
        route, kind, out = j.result()
        print(f"\n== {route} / {kind}")
        for i, o in enumerate(out, 1):
            print(f"  r{i}: {json.dumps(o, ensure_ascii=False)}")
