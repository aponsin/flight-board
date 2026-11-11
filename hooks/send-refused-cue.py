#!/usr/bin/env python3
# PostToolUse hook (#C849): the app caps an agent's sends (10 in a row until the owner next types in that session). A refused send answers
# "Not delivered"; the agent then posts the same line to the card's thread on the store, which is not capped and reaches Manager's inbox
# batch. This hook only gives the cue: it reads the tool's result, and when a SendMessage or send_message was refused it adds one line of
# context. It reads nothing else, writes nothing and never blocks.
# Settings entry: PostToolUse, matcher "SendMessage|mcp__ccd_session_mgmt__send_message", command: python3 ~/.claude/hooks/send-refused-cue.py
import json, re, sys
try:
    inp = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(inp, dict) or not re.fullmatch(r"SendMessage|mcp__ccd_session_mgmt__send_message", str(inp.get("tool_name") or "")):
    sys.exit(0)
try:
    said = json.dumps(inp.get("tool_response"), ensure_ascii=False)
except Exception:
    sys.exit(0)
if re.search(r"not delivered", said, re.I):
    cue = ("That send was NOT delivered (the app's send cap or a closed session). Don't wait for a reply: post the same line to the card's thread "
           "with the store's post tool, which is not capped and reaches Manager's inbox batch, and go on with your work.")
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": cue}}))
sys.exit(0)
