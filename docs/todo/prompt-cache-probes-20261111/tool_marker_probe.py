"""Does OpenRouter honour a cache breakpoint on tool definitions for Claude?
r1 warms; r2 keeps tools identical but changes the system prompt. If a tools
breakpoint exists, r2 still reads the tools segment from cache."""
import json, os, random, time, urllib.request, urllib.error, uuid
from concurrent.futures import ThreadPoolExecutor

S = json.load(open(os.path.expanduser("~/.code-shell/settings.json")))
KEY = next(c for c in S["credentials"] if c["id"] == "openrouter-key")["apiKey"]
OR = "https://openrouter.ai/api/v1"
MODEL = "anthropic/claude-sonnet-5"
CC = {"type": "ephemeral"}


def guide(nonce, n):
    rnd = random.Random(nonce)
    return f"[session {nonce}] Team style guide.\n" + "\n".join(
        f"Rule {i}: when handling item {rnd.randint(1000, 9999)}, keep answers short and confirm the result." for i in range(n))


def tools(nonce):
    rnd = random.Random(nonce + "t")
    out = []
    for i in range(12):
        desc = f"[{nonce}] Tool {i}. " + " ".join(
            f"Use it for case {rnd.randint(1000, 9999)} and report the outcome clearly." for _ in range(18))
        out.append({"name": f"tool_{i}", "description": desc,
                    "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}})
    return out


def post(path, body):
    req = urllib.request.Request(OR + path, data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "anthropic-version": "2023-06-01"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:300]}


def chat(variant, change):
    """change: 'system' rewrites the system prompt in r2, 'none' keeps everything (control)."""
    nonce = uuid.uuid4().hex[:12]
    base = tools(nonce)
    wire = []
    for i, t in enumerate(base):
        entry = {"type": "function", "function": dict(t)}
        if i == len(base) - 1:
            if variant == "top":
                entry["cache_control"] = CC
            if variant == "inner":
                entry["function"]["cache_control"] = CC
        wire.append(entry)
    out = []
    for step in (1, 2):
        text = guide(nonce, 110) + ("\nVariant B applies today." if step == 2 and change == "system" else "")
        r = post("/chat/completions", {"model": MODEL, "max_tokens": 16, "tools": wire, "messages": [
            {"role": "system", "content": [{"type": "text", "text": text, "cache_control": CC}]},
            {"role": "user", "content": "Reply with the single word OK."}]})
        u = r.get("usage") or {}
        d = u.get("prompt_tokens_details") or {}
        out.append({"prompt": u.get("prompt_tokens"), "cached": d.get("cached_tokens"), "write": d.get("cache_write_tokens"),
                    "provider": r.get("provider")} if u else {"error": json.dumps(r)[:300]})
        time.sleep(6)
    return f"chat/{variant}/change={change}", out


def native(change):
    nonce = uuid.uuid4().hex[:12]
    wire = [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools(nonce)]
    wire[-1]["cache_control"] = CC
    out = []
    for step in (1, 2):
        text = guide(nonce, 110) + ("\nVariant B applies today." if step == 2 and change == "system" else "")
        r = post("/messages", {"model": MODEL, "max_tokens": 16, "tools": wire,
                 "system": [{"type": "text", "text": text, "cache_control": CC}],
                 "messages": [{"role": "user", "content": "Reply with the single word OK."}]})
        u = r.get("usage")
        out.append({"input": u.get("input_tokens"), "cache_read": u.get("cache_read_input_tokens"),
                    "cache_write": u.get("cache_creation_input_tokens")} if u else {"error": json.dumps(r)[:300]})
        time.sleep(6)
    return f"messages/tool-marker/change={change}", out


with ThreadPoolExecutor(8) as ex:
    jobs = [ex.submit(chat, v, c) for v in ("none", "top", "inner") for c in ("system", "none")]
    jobs += [ex.submit(native, c) for c in ("system", "none")]
    for j in jobs:
        name, out = j.result()
        print(f"== {name}")
        for i, o in enumerate(out, 1):
            print(f"  r{i}: {json.dumps(o)}")
