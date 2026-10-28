#!/usr/bin/env python3
# Stop hook: a reply with a red ask (🔴) must come with a board "waiting" write in the same turn.
# Agents that aren't Manager should send questions to Manager instead of asking the owner.
# Manager only (the session titled Manager; the owner, 2026-10-18): when the owner's message this turn asks a question
# (a "?" in what he typed, a mid-turn message, or a board comment), the reply must also write a waiting/ans-<topic> item,
# or (board v2 threads, 2026-10-24) answer in a thread: a write to the board's "messages" collection counts as the answer.
# Any titled session (an agent; #C350): when its context is over the config's resetAt (#C399: 600k; 400k before), a reset cue (hand off once the work in
# flight is safe), unless this turn already reset it. The context keeper's 60% cue becomes the fallback. While the owner
# wrote under 10 minutes ago or an ask of theirs is open, the cue waits one turn (#C392): "resetting after this" first.
import glob, json, os, re, sys, time
from datetime import datetime
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
            _r = json.load(_f).get("resetAt")
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
    for c in content:
        if c.get("type") == "text" and RED.search(c.get("text") or ""):
            red = True
        _in = c.get("input") or {}
        if c.get("type") == "tool_use" and ((c.get("name") == "mcp__ccd_session_mgmt__clear_session" and _in.get("session_id") in (None, "", "self")) or (c.get("name") == "Skill" and re.fullmatch(r"(?:[\w-]+:)?handoff", str(_in.get("skill") or "")))):
            cleared = True  # this turn handed off or asked the app to clear it (itself: clearing another session isn't this one's reset)
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
if TITLE and not cleared and tokens is not None and tokens > RESET_AT:
    # Tokens cut down: 600,999 reads 600k, over the line all the same.
    if (fresh or pending) and not deferred:
        why = f"the owner wrote {int((now - owner_at) // 60000)} min ago" if fresh else "an ask of the owner's is open"
        reasons.append(f"Context reset cue: deferred one turn. This session's context is at {tokens // 1000}k tokens, over {LIMIT}, but {why}, so don't reset now: a reset now loses what the owner just set up (the board's auto-replies too). Write \"{DEFER_MARK}\" on the board now (a message in the thread you're answering, from you), finish this turn, and reset with /handoff at the end of the next one.")
    else:
        reasons.append(f"Context reset cue: this session's context is at {tokens // 1000}k tokens, over {LIMIT}. Once the work in flight is committed and pushed (or at the end of this turn if it is), write your handoff note and reset with /handoff, so the next session starts small.")
# The live memory tile (#C392, the owner's ask; Manager's pick A): the Collector's tile is as old as its last run (it read
# 34% at 06:12Z while Manager was at 43% at 06:30Z). This hook knows the context every turn, so it asks the agent to
# write ctx/<Role> itself, but only when the tile is CTX_STALE_MIN old or CTX_DRIFT points off: far below #C334's
# per-turn call. Only a role with a tile from the Collector on this machine (the board's mirror, ~/.flight-board/<board>/
# mirror/ctx/<Role>.json), whose tokens over percent give its window (the model id doesn't say: a 1M session reads
# plain "claude-opus-5-5"), snapped to 200k or 1M. What it last asked is kept in ~/.flight-board/ctx-asks/<Role>.json.
CTX_STALE_MIN, CTX_DRIFT = 30, 5
ROLE_FILE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
def read_json(p):
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except Exception:
        return None
def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None
def tile_ask():
    if not (TITLE and ROLE_FILE.match(TITLE) and tokens):
        return
    fb =os.path.join(os.path.expanduser("~"), ".flight-board")
    tile = None
    for p in glob.glob(os.path.join(glob.escape(fb), "*", "mirror", "ctx", TITLE + ".json")):
        r = read_json(p)
        if r and num(r.get("pct")) and num(r.get("tokens")) and num(r.get("at")) and (tile is None or r["at"] > tile["at"]):
            tile = r
    if tile:
        size = 1000000 if tile["tokens"] * 100 / tile["pct"] > 600000 else 200000
        pct = min(100, round(tokens * 100 / size))
        ms = int(time.time() * 1000)
        asked = read_json(os.path.join(fb, "ctx-asks", TITLE + ".json"))
        last = asked if asked and num(asked.get("at")) and isinstance(asked.get("pct"), (int, float)) and asked["at"] > tile["at"] else tile
        if ms - last["at"] >= CTX_STALE_MIN * 60000 or abs(pct - last["pct"]) >= CTX_DRIFT:
            reasons.append(f"Memory tile: your context is {pct}% of its window ({tokens // 1000}k tokens); the board's tile says {round(last['pct'])}%, {int((ms - last['at']) // 60000)} min old. Write it: ArtifactData get ctx/{TITLE} for its version, then set ctx/{TITLE} {{\"pct\": {pct}, \"tokens\": {tokens}, \"at\": {ms}}} with that if_version (none if it has none). Then finish.")
            try:
                os.makedirs(os.path.join(fb, "ctx-asks"), exist_ok=True)
                with open(os.path.join(fb, "ctx-asks", TITLE + ".json"), "w", encoding="utf-8") as f:
                    json.dump({"pct": pct, "at": ms}, f)
            except Exception:
                pass
# Security's LOW on 7692ec0: the tile is a nicety; an exception in it never drops the hook's other verdicts.
try:
    tile_ask()
except Exception:
    pass
# Two rules left this hook (#C334, the context-tax brief's card A): the memory tile (the Collector writes it from the
# app's numbers, collector/context.mjs) and the read of the waiting items (the Stop gate, gate/stop.mjs, sees the open
# asks the owner answered on the board itself). Each made Manager spend a tool call, and its result, every turn. The
# tile came back throttled (#C392, above): only when it is 30 min old or 5 points off.
if reasons:
    print(json.dumps({"decision": "block", "reason": " ".join(reasons)}))
sys.exit(0)
