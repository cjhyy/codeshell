"""Prompt-cache probe for the context-ledger design (2026-11-12).

Each variant sends three requests with a fresh nonce:
  r1  cold request (writes the cache)
  r2  r1 plus one more tool round (control: should read ~all of r1)
  r3  the variant under test
and prints prompt / cached tokens for each. Synthetic payloads only; never prints keys.

Usage: python3 context_ledger_probe.py <route-substring|all> [reps] [variant-substring]
"""
import json, os, random, sys, time, urllib.request, urllib.error, uuid
from concurrent.futures import ThreadPoolExecutor

S = json.load(open(os.path.expanduser("~/.code-shell/settings.json")))
OR_KEY = {c["id"]: c for c in S["credentials"]}["openrouter-key"]["apiKey"]
OR = "https://openrouter.ai/api/v1/chat/completions"
WORDS = ("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho "
         "sigma tau upsilon phi chi psi omega river stone cloud ember quartz meadow harbor lantern").split()

ROUTES = {
    "gpt": ("openai/gpt-6.1-sol", "openai"),
    "claude": ("anthropic/claude-sonnet-5", "anthropic"),
}
PLACEHOLDER = ("[Old browser snapshot collapsed — superseded by a newer browser_observe(snapshot). "
               "Re-run browser_observe for the current page's elements.]")


def filler(nonce, tag, lines):
    rnd = random.Random(f"{nonce}:{tag}")
    body = "\n".join(
        f"{tag} {i}: item {rnd.randint(1000, 9999)} uses the {rnd.choice(WORDS)} {rnd.choice(WORDS)} checklist; "
        f"keep answers short and confirm with the user."
        for i in range(lines))
    return f"[{tag} for session {nonce}]\n{body}"


TOOLS = [
    {"type": "function", "function": {"name": "Bash", "description": "Run a shell command.",
     "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
    {"type": "function", "function": {"name": "browser_observe", "description": "Observe the current page.",
     "parameters": {"type": "object", "properties": {"mode": {"type": "string"}}, "required": ["mode"]}}},
]


def user(text):
    return {"role": "user", "content": text}


def call(cid, name, args):
    return {"role": "assistant", "content": None, "tool_calls": [
        {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}


def result(cid, text):
    return {"role": "tool", "tool_call_id": cid, "content": text}


def build(nonce):
    """Named message parts shared by every variant."""
    f = lambda tag, n: filler(nonce, tag, n)
    return {
        "SYS": {"role": "system", "content": f("system-and-tools-manual", 130)},
        "U0": user("Earlier task: check the page and report. Reply OK when done."),
        "A0": call("c0", "browser_observe", {"mode": "snapshot"}),
        "SNAP_OLD": result("c0", f("old-snapshot-element", 60)),
        "AFIN0": {"role": "assistant", "content": "OK"},
        "U1": user("New task: run the checks and reply with the single word OK."),
        "DYN_A": user("<system-reminder>\n" + f("skill-and-memory-index", 60) + "\n</system-reminder>"),
        "A1": call("c1", "Bash", {"command": "check one"}),
        "T1": result("c1", f("check-one-output", 60)),
        "A2": call("c2", "Bash", {"command": "check two"}),
        "T2": result("c2", f("check-two-output", 60)),
        "AFIN1": {"role": "assistant", "content": "OK"},
        "U2": user("Follow-up: reply with the single word OK again."),
        # Same index with one memory line changed, as happens after every run.
        "DYN_B": user("<system-reminder>\n" + f("skill-and-memory-index", 60)
                      + "\nskill-and-memory-index 60: new memory about the download folder.\n</system-reminder>"),
        "DELTA": user("<system-reminder>\n<context-update section=\"memory\">\n+ new memory about the download "
                      "folder.\n</context-update>\n</system-reminder>"),
        "A3": call("c3", "browser_observe", {"mode": "snapshot"}),
        "SNAP_NEW": result("c3", f("new-snapshot-element", 60)),
        "SNAP_OLD_MASKED": result("c0", PLACEHOLDER),
        "T1_MASKED": result("c1", PLACEHOLDER),
    }


# Each variant: (r1, r2, r3) as lists of part names, plus the names to mark in each request.
# Marks mirror CodeShell's hybrid layout: system, stable boundary, longest matching prior boundary.
X_R1 = ["SYS", "U1", "DYN_A", "A1", "T1"]
X_R2 = X_R1 + ["A2", "T2"]
M_R1 = ["SYS", "U0", "A0", "SNAP_OLD", "AFIN0", "U1", "DYN_A", "A1", "T1"]
M_R2 = M_R1 + ["A2", "T2"]

VARIANTS = {
    # --- cross-run -----------------------------------------------------------
    "X1-current(remove-old-block)": dict(
        r1=(X_R1, ["SYS", "U1"]), r2=(X_R2, ["SYS", "U1", "T1"]),
        r3=(["SYS", "U1", "A1", "T1", "A2", "T2", "AFIN1", "U2", "DYN_B"], ["SYS", "U2", "U1"])),
    "X2-ledger(keep-block+delta)": dict(
        r1=(X_R1, ["SYS", "U1"]), r2=(X_R2, ["SYS", "U1", "T1"]),
        r3=(X_R2 + ["AFIN1", "U2", "DELTA"], ["SYS", "AFIN1", "T2"])),
    "X3-keep-block+full-resend": dict(
        r1=(X_R1, ["SYS", "U1"]), r2=(X_R2, ["SYS", "U1", "T1"]),
        r3=(X_R2 + ["AFIN1", "U2", "DYN_B"], ["SYS", "AFIN1", "T2"])),
    # --- in-run rewrite of an old snapshot -----------------------------------
    "M1-current(mask-old+move-block)": dict(
        r1=(M_R1, ["SYS", "U1"]), r2=(M_R2, ["SYS", "U1", "T1"]),
        r3=(["SYS", "U0", "A0", "SNAP_OLD_MASKED", "AFIN0", "U1", "A1", "T1", "A2", "T2", "A3", "SNAP_NEW", "DYN_A"],
            ["SYS", "SNAP_NEW"])),
    "M2-deferred(no-rewrite)": dict(
        r1=(M_R1, ["SYS", "U1"]), r2=(M_R2, ["SYS", "U1", "T1"]),
        r3=(M_R2 + ["A3", "SNAP_NEW"], ["SYS", "U1", "T2"])),
    "M3-mask-old-only(block-stays)": dict(
        r1=(M_R1, ["SYS", "U1"]), r2=(M_R2, ["SYS", "U1", "T1"]),
        r3=(["SYS", "U0", "A0", "SNAP_OLD_MASKED", "AFIN0", "U1", "DYN_A", "A1", "T1", "A2", "T2", "A3", "SNAP_NEW"],
            ["SYS", "U1"])),
    "M4-rewrite-after-run-start-marker": dict(
        r1=(M_R1, ["SYS", "DYN_A"]), r2=(M_R2, ["SYS", "DYN_A", "T1"]),
        r3=(["SYS", "U0", "A0", "SNAP_OLD", "AFIN0", "U1", "DYN_A", "A1", "T1_MASKED", "A2", "T2", "A3", "SNAP_NEW"],
            ["SYS", "DYN_A"])),
}
# --- follow-ups after the first run -------------------------------------------
M5_R3 = ["SYS", "U0", "A0", "SNAP_OLD", "AFIN0", "U1", "DYN_A", "A1", "T1_MASKED", "A2", "T2", "A3", "SNAP_NEW"]
VARIANTS.update({
    # Is a read tied to a marker, or to the longest common prefix? Only marker is far before the rewrite.
    "M5-rewrite-late/marker-early": dict(
        r1=(M_R1, ["SYS", "U0"]), r2=(M_R2, ["SYS", "U0", "T1"]), r3=(M5_R3, ["SYS", "U0"])),
    "M5i-rewrite-late/implicit-only": dict(r1=(M_R1, []), r2=(M_R2, []), r3=(M5_R3, []), implicit=True),
    # Ledger layout, but every string content is sent as a text-block array in all three requests.
    "X2a-ledger/array-content": dict(
        r1=(X_R1, ["SYS", "U1"]), r2=(X_R2, ["SYS", "U1", "T1"]),
        r3=(X_R2 + ["AFIN1", "U2", "DELTA"], ["SYS", "AFIN1", "T2"]), array=True),
    # Ledger layout, keeping the marker on U1 in the next run.
    "X2m-ledger/keep-U1-marked": dict(
        r1=(X_R1, ["SYS", "U1"]), r2=(X_R2, ["SYS", "U1", "T1"]),
        r3=(X_R2 + ["AFIN1", "U2", "DELTA"], ["SYS", "U1", "T2"])),
})
# Same requests with no explicit markers at all: shows whether reads are tied to markers.
for base in ("X1-current(remove-old-block)", "M1-current(mask-old+move-block)", "M3-mask-old-only(block-stays)"):
    v = VARIANTS[base]
    VARIANTS[base.split("-")[0] + "i-" + base.split("-", 1)[1] + "/implicit-only"] = dict(
        r1=(v["r1"][0], []), r2=(v["r2"][0], []), r3=(v["r3"][0], []), implicit=True)


def materialize(parts, names, marks, style, array=False):
    msgs = []
    for n in names:
        m = json.loads(json.dumps(parts[n]))
        if array and n not in marks and isinstance(m.get("content"), str) and m["role"] != "assistant":
            m["content"] = [{"type": "text", "text": m["content"]}]
        if n in marks and isinstance(m.get("content"), str):
            marker = ({"cache_control": {"type": "ephemeral"}} if style == "anthropic"
                      else {"prompt_cache_breakpoint": {"mode": "explicit"}})
            m["content"] = [{"type": "text", "text": m["content"], **marker}]
        msgs.append(m)
    return msgs


def post(body):
    req = urllib.request.Request(OR, data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": f"Bearer {OR_KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:300]}
    except Exception as e:  # noqa
        return {"http_error": -1, "body": repr(e)[:200]}


def send(model, style, nonce, msgs, implicit):
    body = {"model": model, "messages": msgs, "tools": TOOLS, "max_tokens": 64, "stream": False,
            "session_id": nonce}
    if style == "openai":
        body["prompt_cache_key"] = nonce
        if not implicit:
            body["prompt_cache_options"] = {"mode": "implicit", "ttl": "30m"}
    resp = post(body)
    if "usage" not in resp:
        return {"error": json.dumps(resp, ensure_ascii=False)[:260]}
    u = resp["usage"]
    d = u.get("prompt_tokens_details") or {}
    return {"prompt": u.get("prompt_tokens"), "cached": d.get("cached_tokens") or 0,
            "write": d.get("cache_write_tokens"), "provider": resp.get("provider")}


def run_variant(route, name, rep):
    model, style = ROUTES[route]
    v = VARIANTS[name]
    nonce = uuid.uuid4().hex[:16]
    parts = build(nonce)
    out = []
    for key in ("r1", "r2", "r3"):
        names, marks = v[key]
        # Anthropic route also marks the last message (CodeShell's rolling breakpoint).
        marks = list(marks) + ([names[-1]] if style == "anthropic" and not v.get("implicit") else [])
        out.append(send(model, style, nonce, materialize(parts, names, marks, style, v.get("array", False)), v.get("implicit", False)))
        if key != "r3":
            time.sleep(8)
    return route, name, rep, out


if __name__ == "__main__":
    want = sys.argv[1] if len(sys.argv) > 1 else "all"
    reps = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    only = sys.argv[3] if len(sys.argv) > 3 else ""
    jobs = []
    with ThreadPoolExecutor(max_workers=24) as ex:
        for route in ROUTES:
            if want != "all" and want not in route:
                continue
            for name, v in VARIANTS.items():
                if only and only not in name:
                    continue
                if v.get("implicit") and ROUTES[route][1] == "anthropic":
                    continue  # Anthropic has no implicit caching to compare against.
                for rep in range(reps):
                    jobs.append(ex.submit(run_variant, route, name, rep))
        rows = sorted((j.result() for j in jobs), key=lambda r: (r[0], r[1], r[2]))
    for route, name, rep, out in rows:
        print(f"\n== {route} / {name} / rep{rep}")
        for i, o in enumerate(out, 1):
            print(f"  r{i}: {json.dumps(o, ensure_ascii=False)}")
        if all("prompt" in o for o in out):
            print(f"  -> r3 reused {out[2]['cached']} of r2's {out[1]['prompt']} "
                  f"({100 * out[2]['cached'] / out[1]['prompt']:.0f}%)")
