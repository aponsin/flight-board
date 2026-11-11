#!/usr/bin/env python3
# Stop hook: a reply with a red ask (🔴) must come with a board "waiting" write in the same turn.
# Agents that aren't Manager should send questions to Manager instead of asking the owner.
# Manager only (the session titled Manager; the owner, 2026-10-18): when the owner's message this turn asks a question
# (a "?" in what he typed, a mid-turn message, or a board comment), the reply must also write a waiting/ans-<topic> item,
# or (board v2 threads, 2026-10-24) answer in a thread: a write to the board's "messages" collection counts as the answer.
# Any titled session (an agent; #C350): when its context is over the config's resetAt (#C399: 600k; 400k before), a reset cue (hand off once the work in
# flight is safe), unless this turn already reset it. The context keeper's 60% cue becomes the fallback. While the owner
# wrote under 10 minutes ago or an ask of theirs is open, the cue waits one turn (#C392): "resetting after this" first.
import json, os, re, sys
from datetime import datetime
# The flight-board store's connector tools: mcp__<connector id>__ask, mcp__<connector id>__post (the id is the connector's uuid).
STORE_TOOL = re.compile(r"^mcp__[0-9A-Za-z-]{8,64}__(?:ask|post)$")
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
TITLE = ""
for _l in lines:
    try:
        _e = json.loads(_l)
    except Exception:
        continue
    if isinstance(_e, dict) and isinstance(_e.get("customTitle"), str) and _e["customTitle"].strip():
        TITLE = _e["customTitle"].strip()
MANAGER = TITLE == "Manager"
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
# The reset limit is the board config's resetAt (#C399, the owner's 600k in #T1038), so a new limit is a config change,
# never a new hook: the config is the one the board's Stop gate is registered with in ~/.claude/settings.json ("…/gate/
# stop.mjs' --config '<path>'"). No config, or no good value: 400k, the limit before.
RESET_AT = 400000
try:
    with open(os.path.join(os.path.expanduser("~"), ".claude", "settings.json"), encoding="utf-8") as _f:
        _m = re.search(r"/gate/stop\.mjs' --config '([^'\n]{1,300})'", _f.read())
    if _m:
        with open(os.path.expanduser(_m.group(1)), encoding="utf-8") as _f:
            _cfg = json.load(_f)
        _r = _cfg.get("resetAt")
        # A whole number written 600000.0 or 6e5 is a float to json.load but whole to checkConfig (Security's LOW).
        if isinstance(_r, (int, float)) and not isinstance(_r, bool) and 100000 <= _r <= 2000000 and _r == int(_r):
            RESET_AT = int(_r)
except Exception:
    pass
# A turn that is itself a reset: the owner's /handoff, /clear or /compact, or the keeper's cue alone on its line.
RESET_CMD = re.compile(r"<command-name>/(?:handoff|clear|compact)</command-name>")
RESET_CUE = re.compile(r"(?:^|[:>])\s*CONTEXT RESET\s*(?:$|<)", re.M)
def used(u):
    if not isinstance(u, dict):
        return None
    n = [u.get(k) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
    return sum(x for x in n if isinstance(x, int) and not isinstance(x, bool) and x >= 0)
red = wrote = question = answered = cleared = False
# #C848: any titled agent but Manager whose turn ends on a question, in a turn that sent nothing to Manager, is refused once: nobody reads
# that chat. last_text is the turn's last text block (the first met going backwards); sent_manager, any send to Manager (SendMessage to
# Manager or to a session id, send_message, or the store's ask or post).
last_text = None
sent_manager = False
QUESTION_END = re.compile(r"\?[\s*_`\"')\]]*$")
closed = set()  # waiting items this turn marked done or deleted (#C582)
tokens = None  # the latest call's context; a compaction after it leaves none
for line in reversed(lines):
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("type") == "system" and e.get("subtype") == "compact_boundary" and tokens is None:
        tokens = 0
    msg = e.get("message") or {}
    content = msg.get("content")
    if e.get("type") == "assistant" and tokens is None and not e.get("isSidechain") and isinstance(msg.get("usage"), dict):
        tokens = used(msg.get("usage"))
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
        if any(RESET_CMD.search(t) or RESET_CUE.search(t) for t in texts(content)):
            cleared = True
        break  # start of this turn
    if e.get("type") != "assistant" or not isinstance(content, list):
        continue
    for c in reversed(content):
        if c.get("type") == "text" and last_text is None and not e.get("isSidechain") and (c.get("text") or "").strip():
            last_text = c["text"]
        if c.get("type") == "text" and RED.search(c.get("text") or ""):
            red = True
        _in = c.get("input") or {}
        if c.get("type") == "tool_use" and not e.get("isSidechain"):
            _to = str(_in.get("to") or "")
            if (c.get("name") == "SendMessage" and (_to.lower().startswith("manager") or _to.startswith("local_"))) or c.get("name") == "mcp__ccd_session_mgmt__send_message" or STORE_TOOL.match(str(c.get("name") or "")):
                sent_manager = True
        if c.get("type") == "tool_use" and ((c.get("name") == "mcp__ccd_session_mgmt__clear_session" and _in.get("session_id") in (None, "", "self")) or (c.get("name") == "Skill" and re.fullmatch(r"(?:[\w-]+:)?handoff", str(_in.get("skill") or "")))):
            cleared = True  # this turn handed off or asked the app to clear it (itself: clearing another session isn't this one's reset)
        # The board's writes: the old ArtifactData, or the claude-artifacts server's db_write (#C652), whose ops carry
        # a path "collection/id" and an op set|merge|update|delete.
        # The store's own tools (#C825): its ask is a waiting item, its post is a message in a thread; either counts as the board write
        # (a red ask on the store was refused once for want of an ArtifactData write).
        if c.get("type") == "tool_use" and STORE_TOOL.match(str(c.get("name") or "")):
            if c["name"].endswith("__ask"):
                wrote = True
            answered = True
        if c.get("type") == "tool_use" and c.get("name") in ("ArtifactData", "mcp__claude-artifacts__db_write"):
            new = c.get("name") != "ArtifactData"
            s = json.dumps(c.get("input") or {})
            writes = any(a in s for a in (('"set"', '"merge"', '"update"') if new else ('"set"', '"update"', '"batch"')))
            try:
                if new:
                    _w = [{"collection": o["path"].rsplit("/", 1)[0], "doc_id": o["path"].rsplit("/", 1)[1], "data": o.get("data"), "op": o.get("op")}
                          for o in (_in.get("ops") if isinstance(_in.get("ops"), list) else []) if isinstance(o, dict) and isinstance(o.get("path"), str) and "/" in o["path"]]
                else:
                    _w = _in.get("writes") if _in.get("action") == "batch" else [_in]
                for _x in _w if isinstance(_w, list) else []:
                    if isinstance(_x, dict) and _x.get("collection") == "waiting" and isinstance(_x.get("doc_id"), str):
                        _d = _x.get("data") if isinstance(_x.get("data"), dict) else {}
                        if _x.get("action") == "delete" or _x.get("op") == "delete" or _d.get("done") is True or isinstance(_d.get("doneAt"), (int, float)):
                            closed.add(_x["doc_id"])
            except Exception:
                pass
            if new:
                # Collections and ids as the old tool's text carried them: "waiting" in s, "ans-" in s.
                s = " ".join('"%s"' % x for x in [o.get("path", "").rsplit("/", 1)[0] for o in (_in.get("ops") or []) if isinstance(o, dict) and isinstance(o.get("path"), str)]) + " " + " ".join('"%s' % o.get("path", "").rsplit("/", 1)[-1] for o in (_in.get("ops") or []) if isinstance(o, dict) and isinstance(o.get("path"), str))
            if '"waiting"' in s and writes:
                wrote = True
                if '"ans-' in s:
                    answered = True
            if '"messages"' in s and writes:
                answered = True  # answered in the thread (board v2): never push Manager into a new ans- item
reasons = []
if red and not wrote:
    reasons.append("Your reply has a red ask (🔴) but you wrote nothing to the flight board's 'waiting' collection this turn. Manager: raise it now with the store's ask tool, then finish. Any other agent: don't ask the owner directly; send the question to Manager and remove the 🔴.")
elif TITLE and not MANAGER and last_text and QUESTION_END.search(last_text.rstrip()) and not sent_manager:
    reasons.append("Nobody reads this chat. If it is in your lane, do it; otherwise send the question to Manager.")
elif MANAGER and question and not answered:
    reasons.append("The owner asked a question this turn, but you wrote no board answer. Manager: answer it in its thread with the store's post tool; if it has no thread, raise an Answer with the store's ask tool. Then finish.")
# The cue waits one turn while the owner is in the middle of something (#C392): Manager's 06:31Z reset threw away the
# board auto-replies the owner had turned on at 06:30Z. The owner wrote under 10 minutes ago (by the transcript's own
# times: "now" is its newest entry), or an ask of theirs is open (the owner's question with no board answer, or a red
# ask this turn): the agent writes "resetting after this" on the board and stops; the next turn's cue is the reset.
OWNER_FRESH_MS = 10 * 60000
DEFER_MARK = "resetting after this"
def stamp(e):
    try:
        return datetime.fromisoformat(str(e.get("timestamp")).replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return None
def owner_word(e):
    if e.get("type") == "queue-operation" and e.get("reason") == "absorbed_mid_turn":
        return True
    if e.get("type") != "user" or e.get("isMeta"):
        return False
    for t in texts((e.get("message") or {}).get("content")):
        t = re.sub(r"<system-reminder>.*?</system-reminder>", "", t or "", flags=re.S).strip()
        if MID in t or (t and not t.startswith(("<", "Stop hook feedback", "Another Claude session sent", "Base directory for this skill"))):
            return True
    return False
# Returns (now, the owner's last word's time, deferred): deferred, a deferral cue since the last reset (this cue no
# longer waits).
def scan():
    now = owner_at = None
    deferred = False
    for line in lines:
        try:
            e = json.loads(line)
        except Exception:
            continue
        if not isinstance(e, dict):
            continue
        at = stamp(e)
        if at is not None:
            now = at if now is None else max(now, at)
        if e.get("type") == "system" and e.get("subtype") == "compact_boundary":
            deferred = False
        if e.get("type") == "user":
            ts = texts((e.get("message") or {}).get("content"))
            if any(RESET_CMD.search(t) or RESET_CUE.search(t) for t in ts):
                deferred = False
            if any(t.lstrip().startswith("Stop hook feedback") and "Context reset cue: deferred" in t for t in ts):
                deferred = True
        if at is not None and owner_word(e):
            owner_at = at
    return now, owner_at, deferred
# Security's LOW on 7692ec0: an exception here must never drop the hook's other verdicts; the plain cue stands.
try:
    now, owner_at, deferred = scan()
except Exception:
    now = owner_at = None
    deferred = True
fresh = now is not None and owner_at is not None and now - owner_at < OWNER_FRESH_MS
pending = red or (question and not answered)
LIMIT = f"{RESET_AT // 1000}k"
# The reset itself, named (#C434: Manager wrote the handoff and kept working, clearing 140k past the line): the clear is
# the turn's last action, and this hook reads that call as the turn's reset (cleared, above).
CLEAR_ACT = "after the handoff note, call mcp__ccd_session_mgmt__clear_session with session_id \"self\" as the last action of the turn (nothing after it)."
# Manager's own clear asks for its pickup (#C498, the owner's pick A: Manager cleared itself at 02:52Z and sat idle with
# Remote Control off until Director sent /pickup by hand at 02:57Z; the keeper runs hourly). Steward watches for Manager
# going idle and sends "/pickup Manager"; the keeper's step 4 stays the backstop.
BUDDY, WATCH = "Steward", "PICKUP WATCH Manager"
if MANAGER:
    CLEAR_ACT = f"after the handoff note, send the session titled \"{BUDDY}\" exactly \"{WATCH}\" (SendMessage, nothing else in it), so it picks you up once you're idle; then call mcp__ccd_session_mgmt__clear_session with session_id \"self\" as the last action of the turn (nothing after it)."
if TITLE and not cleared and tokens is not None and tokens > RESET_AT:
    # Tokens cut down: 600,999 reads 600k, over the line all the same.
    if (fresh or pending) and not deferred:
        why = f"the owner wrote {int((now - owner_at) // 60000)} min ago" if fresh else "an ask of the owner's is open"
        reasons.append(f"Context reset cue: deferred one turn. This session's context is at {tokens // 1000}k tokens, over {LIMIT}, but {why}, so don't reset now: a reset now loses what the owner just set up (the board's auto-replies too). Write \"{DEFER_MARK}\" on the board now (a message in the thread you're answering, from you), finish this turn, and reset with /handoff at the end of the next one: {CLEAR_ACT}")
    else:
        reasons.append(f"Context reset cue: this session's context is at {tokens // 1000}k tokens, over {LIMIT}. Once the work in flight is committed and pushed (or at the end of this turn if it is), write your handoff note and reset with /handoff, so the next session starts small: {CLEAR_ACT}")
# Two rules left this hook with the board on the store (#C825): the memory tile (the probe writes the store's ctx evidence from the app's
# numbers) and the answered-but-open check (the store closes and answers by its own tools; the Worker holds the state, there is no mirror
# to read). What stays: the red ask, the owner's question and the context-reset cue.
if reasons:
    print(json.dumps({"decision": "block", "reason": " ".join(reasons)}))
sys.exit(0)
