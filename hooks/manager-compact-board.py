#!/usr/bin/env python3
# SessionStart hook, matcher "compact" (#C559): Manager now compacts at ~40% of its window instead of being cleared at
# the keeper's wave. A compaction leaves a summary, and a summary is not the board: card states, thread ids and who
# owes what in it go stale. So the session that was just compacted is told what is true (the board and its pick-up
# note), to run the pickup digest, and where the board is. Pointers only; the board holds the rest. Manager only (the
# session titled Manager): every other role is cleared by the keeper and picked up, never compacted on purpose.
# The docs give no way for a PreCompact hook to shape the summary (it can only block), so there is none here.
import json, os, re, sys
try:
    inp = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(inp, dict) or inp.get("source") != "compact":
    sys.exit(0)
# The title: the event's session_title when it has one, else the transcript's latest customTitle, as the Stop hook reads it.
title = inp.get("session_title") if isinstance(inp.get("session_title"), str) else ""
if not title.strip():
    try:
        for _l in open(inp.get("transcript_path") or "", encoding="utf-8").read().splitlines():
            try:
                _e = json.loads(_l)
            except Exception:
                continue
            if isinstance(_e, dict) and isinstance(_e.get("customTitle"), str) and _e["customTitle"].strip():
                title = _e["customTitle"]
    except Exception:
        pass
if title.strip() != "Manager":
    sys.exit(0)
# The board's link: the storeUrl of the config the board's Stop gate is registered with in ~/.claude/settings.json (#C825: the board is on
# the store; never a typed address, never the old artifact).
link = ""
try:
    with open(os.path.join(os.path.expanduser("~"), ".claude", "settings.json"), encoding="utf-8") as _f:
        _m = re.search(r"/gate/stop\.mjs' --config '([^'\n]{1,300})'", _f.read())
    if _m:
        with open(os.path.expanduser(_m.group(1)), encoding="utf-8") as _f:
            _u = json.load(_f).get("storeUrl")
        if isinstance(_u, str) and re.fullmatch(r"https://[A-Za-z0-9.-]{1,200}(:[0-9]{1,5})?/?", _u):
            link = _u
except Exception:
    pass
text = (
    "You were just compacted: your context is now a summary. The board and your pick-up note are the truth, not the summary. "
    "Card states, thread ids, open asks and who owes what in the summary may be stale; do not act on them. "
    "Run the pickup digest now (your /pickup steps: read the board and your newest hand-over note), then go on from what they say."
)
text += f" The board: {link}." if link else " Its link is not in this hook's reach: ask the owner to paste it once."
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}))
