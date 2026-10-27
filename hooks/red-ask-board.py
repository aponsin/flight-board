#!/usr/bin/env python3
# Stop hook: a reply with a red ask (🔴) must come with a board "waiting" write in the same turn.
# Agents that aren't Manager should send questions to Manager instead of asking the owner.
# Manager only (the session titled Manager; the owner, 2026-10-18): when the owner's message this turn asks a question
# (a "?" in what he typed, a mid-turn message, or a board comment), the reply must also write a waiting/ans-<topic> item,
# or (board v2 threads, 2026-10-24) answer in a thread: a write to the board's "messages" collection counts as the answer.
import json, os, re, sys
RED = re.compile(r"^\s*(?:[-*>]\s*)?(?:\*\*)?\U0001F534", re.M)  # only a line that starts with the red mark is an ask
try:
    inp = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if inp.get("stop_hook_active"):
    sys.exit(0)
path = inp.get("transcript_path")
if not path:
    sys.exit(0)
try:
    lines = open(path, encoding="utf-8").read().splitlines()
except Exception:
    sys.exit(0)
# Manager = the session's title in the app (its latest "customTitle"), never a "/pickup Manager" found anywhere in the
# transcript: that text also turns up quoted (a test file, a pasted message) and once made other roles act as Manager.
MANAGER = False
for _l in lines:
    try:
        _e = json.loads(_l)
    except Exception:
        continue
    if isinstance(_e, dict) and isinstance(_e.get("customTitle"), str) and _e["customTitle"].strip():
        MANAGER = _e["customTitle"].strip() == "Manager"
MID = "The user sent a new message while you were working:"
def asks(text):
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text or "", flags=re.S)
    if MID in text:
        text = text.split(MID, 1)[1].split("This is how Claude Code surfaces", 1)[0]
    elif text.lstrip().startswith("[Artifact comment sent to Claude]"):
        text = "\n".join(l for l in text.splitlines() if l.startswith(">"))
        if re.search(r"^>\s*Board reply \[", text, re.M):
            # a board button press quotes Manager's own item text; only the owner's note counts
            text = text.split("Note:", 1)[1] if "Note:" in text else ""
    elif text.lstrip().startswith(("<", "Stop hook feedback", "Another Claude session sent", "Base directory for this skill")):
        return False
    return "?" in text
def texts(content):
    if isinstance(content, str):
        return [content]
    out = []
    for c in content if isinstance(content, list) else []:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "text":
            out.append(c.get("text") or "")
        elif c.get("type") == "tool_result":
            out.extend(texts(c.get("content")))
    return out
red = wrote = question = answered = False
for line in reversed(lines):
    try:
        e = json.loads(line)
    except Exception:
        continue
    msg = e.get("message") or {}
    content = msg.get("content")
    if e.get("type") == "queue-operation" and e.get("reason") == "absorbed_mid_turn" and "?" in str(e.get("content") or ""):
        question = True  # a message the owner typed while the turn was running
        continue
    if e.get("type") == "user":
        if any(MID in t and asks(t) for t in texts(content)):
            question = True  # a message the owner sent mid-turn
        if isinstance(content, list) and content and all(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            continue
        if any(asks(t) for t in texts(content)):
            question = True
        break  # start of this turn
    if e.get("type") != "assistant" or not isinstance(content, list):
        continue
    for c in content:
        if c.get("type") == "text" and RED.search(c.get("text") or ""):
            red = True
        if c.get("type") == "tool_use" and c.get("name") == "ArtifactData":
            s = json.dumps(c.get("input") or {})
            writes = any(a in s for a in ('"set"', '"update"', '"batch"'))
            if '"waiting"' in s and writes:
                wrote = True
                if '"ans-' in s:
                    answered = True
            if '"messages"' in s and writes:
                answered = True  # answered in the thread (board v2): never push Manager into a new ans- item
reasons = []
if red and not wrote:
    reasons.append("Your reply has a red ask (🔴) but you wrote nothing to the flight board's 'waiting' collection this turn. Manager: add the waiting item now (ArtifactData set), then finish. Any other agent: don't ask the owner directly; send the question to Manager and remove the 🔴.")
elif MANAGER and question and not answered:
    reasons.append("The owner asked a question this turn, but you wrote no board answer. Manager: answer in its thread (messages {thread, from: \"Manager\", text, at}); if it has no thread, add waiting/ans-<topic> {kind:\"answer\", question, text, since, done:false}. Then finish.")
# Manager's memory tile (the owner, 2026-10-19): the board's ctx/Manager pct must stay within 2 points of the real context.
if MANAGER:
    now = shown = None
    for line in lines:
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "assistant":
            continue
        msg = e.get("message") or {}
        u = msg.get("usage")
        if u:
            now = sum(u.get(k) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")) / 10000
        for c in msg.get("content") or []:
            if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "ArtifactData":
                i = c.get("input") or {}
                for w in i.get("writes") or [i]:
                    if w.get("collection") == "ctx" and w.get("doc_id") == "Manager" and isinstance((w.get("data") or {}).get("pct"), (int, float)):
                        shown = w["data"]["pct"]
    if now is not None and (shown is None or abs(now - shown) >= 2):
        reasons.append(f"Manager's memory tile on the board says {shown if shown is not None else 'nothing'}% but your context is {round(now)}%. Update it now in one batch: meta/context agents.Manager.pct and ctx/Manager {{pct, at}} (real clock, if_version), then finish.")
# Board answers (the owner, 2026-10-23): every Manager turn reads the board's waiting items and acts on each answer of the owner's
# still open (a response other than "ack" on an item not done). On 2026-10-23 five answers were missed while Manager was busy.
# The read is the open items only, whole (#C329: a day of items was ~80, ~4k tokens a turn; the open ones are a handful):
# a query of waiting where done == false and nothing else, limit 1000 or more, inline (out_dir lists 50 paths), not cut
# short. A result too large for the transcript is read from its saved copy in this session's own tool-results folder.
MANY = 1000
CUT = re.compile(r"next_cursor|\[\d+ more\b|\bmore (?:saved )?documents\b", re.I)
SAVED = re.compile(r"<persisted-output>[\s\S]*?Full output saved to: (\S+)")
def open_read(i):
    q = i.get("query") if isinstance(i.get("query"), dict) else {}
    where = q.get("where") if isinstance(q.get("where"), list) else []
    try:
        many = float(q.get("limit")) >= MANY
    except Exception:
        many = False
    return (i.get("action") == "query" and i.get("collection") == "waiting" and not i.get("out_dir") and many
            and len(where) == 1 and isinstance(where[0], list) and len(where[0]) == 3
            and where[0][0] == "done" and where[0][1] in ("==", "eq") and where[0][2] is False)
def whole_body(body, results):
    m = SAVED.search(body)
    if not m:
        return body
    if not results:
        return None
    try:
        f, root = os.path.realpath(m.group(1)), os.path.realpath(results)
        if not f.startswith(root + os.sep) or not os.path.isfile(f) or os.path.getsize(f) > 64e6:
            return None
        raw = open(f, encoding="utf-8").read()
        try:
            j = json.loads(raw)
            if isinstance(j, list):
                return "\n".join((c or {}).get("text") or "" for c in j if isinstance(c, dict))
        except Exception:
            pass
        return raw
    except Exception:
        return None
if MANAGER:
    results = os.path.join(path[:-len(".jsonl")] if path.endswith(".jsonl") else path, "tool-results")
    start = 0
    for i in range(len(lines) - 1, -1, -1):
        try:
            e = json.loads(lines[i])
        except Exception:
            continue
        c = (e.get("message") or {}).get("content")
        if e.get("type") == "user" and not (isinstance(c, list) and c and all(isinstance(x, dict) and x.get("type") == "tool_result" for x in c)):
            start = i
            break
    reads, written, items, whole = {}, set(), {}, False
    for line in lines[start:]:
        try:
            e = json.loads(line)
        except Exception:
            continue
        c = (e.get("message") or {}).get("content")
        if not isinstance(c, list):
            continue
        for x in c:
            if not isinstance(x, dict):
                continue
            if x.get("type") == "tool_use" and x.get("name") == "ArtifactData":
                i = x.get("input") or {}
                if open_read(i):
                    reads[x.get("id")] = i
                for w in i.get("writes") or ([i] if i.get("action") in ("set", "update", "delete", "str_replace") else []):
                    if isinstance(w, dict) and w.get("collection") == "waiting" and w.get("doc_id"):
                        written.add(w["doc_id"])
            elif x.get("type") == "tool_result" and x.get("tool_use_id") in reads:
                body = whole_body("\n".join(texts(x.get("content"))), results)
                if body is None or CUT.search(body):
                    continue
                whole = True
                for l in body.split("\n"):
                    if not l.startswith("{"):
                        continue
                    try:
                        d = json.loads(l)
                    except Exception:
                        continue
                    if isinstance(d, dict) and isinstance(d.get("id"), str) and isinstance(d.get("data"), dict) and "version" in d:
                        items[d["id"]] = d["data"]
    if not whole:
        reasons.append("Manager: read the board's open waiting items this turn before finishing (ArtifactData query, collection waiting, where done == false, limit 1000, no out_dir; nothing else in where), then act on every item with a response other than ack.")
    else:
        open_ = [k for k, v in items.items() if isinstance(v, dict) and not v.get("done") and isinstance(v.get("response"), dict) and v["response"].get("status") not in (None, "ack") and k not in written]
        if open_:
            reasons.append("Manager: the owner answered these board items and they're still open: " + ", ".join(sorted(open_)) + ". Act on each (tell the owner, reply) and mark it done (waiting update done:true, if_version) before finishing.")
if reasons:
    print(json.dumps({"decision": "block", "reason": " ".join(reasons)}))
sys.exit(0)
