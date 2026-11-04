# The lead's morning clear

The scheduled task that starts the lead fresh each morning (#C560, Director for the owner): it sends Manager "CONTEXT
RESET" and, once Manager has cleared, "/pickup Manager", as the keeper's step 6 does for the wave. The lead saves the
prompt below into the task (`update_scheduled_task`) after a release that changes it, with the team's values in place of
`{{FOLDERS}}` and `{{TEAM}}`, filled the same way as the keeper's (keeper/TASK.md). Daily at 06:40 local time (cron
`40 6 * * *`; the task's cron is the machine's local time). The card says 06:45: the tool starts a run some
minutes late, and the run may wait out a working Manager, so 06:40 keeps "fresh before 07:00".

The pickup is told by `scripts/pickup-watch.mjs` (#C498, Steward's watch), not the keeper's step-6 rule: an idle session
reads 0 Messages, so "idle and under 5,000" would send a second /pickup to a Manager just picked up. The card's "under
25k" is that Messages rule: the total never falls that low (some 88k of tools, prompt and memory in a cleared session).
The script's "picked-up" reads a working session under 60,000 Messages tokens at an earlier check as a pickup, so the
task skips a Manager already that small before the reset (it is fresh already, and its reset turn would read as one).

Steward may send "/pickup Manager" too (#C498: it does for Manager's own clears, and may for this one). Whichever
sender is second sees a Manager already picked up: this task's script reads "picked-up" and sends nothing more, so the
pickup goes out once either way.

The task's permissions allow Bash for exactly the command `sleep 60` (an exact rule) and for the pickup-watch script
under the same rule Steward holds, `Bash(node ~/.flight-board/current/scripts/pickup-watch.mjs *)`, never Bash in
general (Security): the task reads session titles, so a broad grant would let a crafted title run commands. It never
reads or writes the board, so it has no database-tool rule (no `mcp__claude-artifacts__db_*`); Manager records its own pickedAt (the keeper's step 4 then
skips it).

## Prompt

```
You are the {{TEAM}} morning clear. You reset the lead, Manager, once a day and pick it back up yourself. Never clear a session yourself, never touch Remote Control, and message only the session titled "Manager". Be brief and cheap.

1. Load tools with ToolSearch: "select:mcp__ccd_session_mgmt__list_sessions,mcp__ccd_session_mgmt__get_usage,mcp__ccd_session_mgmt__send_message".
2. list_sessions (limit 100; old scheduled-task runs crowd the list). Find the one session that is not archived, whose cwd contains one of: {{FOLDERS}}, and whose title is exactly "Manager". None: reply "Manager missing" and stop. Never message Director or any scheduled-task session.
3. Wait for Manager to be idle: if its row says working, wait with a background shell sleep of 60 seconds (Bash, run_in_background: true, "sleep 60"; never a foreground sleep) and list again, at most 15 waits. Still working after that: send nothing, reply "Manager busy, no reset" and stop.
4. get_usage with its sessionId. Skip the reset only on a real reading: its context status is "ok" and the tokens of its "Messages" category are under 60,000 (a category not listed counts as 0 only when the status is "ok"). Then it is fresh already; send nothing, reply "Manager fresh at <tokens>, no reset" and stop. A status that isn't "ok" (an idle session whose process has stopped reports its context unavailable, with no categories) is no reading: reset anyway, never skip on it.
5. Send Manager exactly "CONTEXT RESET" and nothing else.
6. Pick it back up: keep a list of readings, empty at first. Wait with a background "sleep 60" as in step 3, then read Manager's row state from list_sessions ("idle" or "working") and its Messages tokens from get_usage, add {"state":"<state>","tokens":<tokens>} to the list, and run exactly (one Bash call, nothing around it) node ~/.flight-board/current/scripts/pickup-watch.mjs '<the list as JSON>'. It prints one word: "send": send Manager exactly "/pickup Manager" and nothing else, once, then go to step 7. "wait": wait and read again. "picked-up" or "give-up": send nothing more and go to step 7.
7. If you sent the pickup, send Manager, as its own message: "Morning clear: CONTEXT RESET and /pickup Manager sent. Set agents.Manager.pickedAt on the board's meta/context to now (milliseconds) and delete its saved, savedTokens and savedPct." Reply with one line: the messages sent and the script's last word.
```

## Dry run (the acceptance)

Before saving the prompt into the live task, rehearse it on a test role so the real lead is not reset:

1. Start a session in a folder that contains one of `{{FOLDERS}}`, titled "Rehearsal" with Remote Control on, and work it
   past 60,000 Messages tokens. Make a copy of the prompt with "Rehearsal" in place of "Manager" everywhere.
2. Run the copy once as a one-time scheduled task. Rehearsal gets "CONTEXT RESET", hands off and clears itself.
3. Pass when, without anyone else's help, the run sends "/pickup Rehearsal" once, Rehearsal picks up from its note
   (the pickup's "paste the board link" item and push included, #C434), and Remote Control is on again for it.
4. Delete the one-time task and archive Rehearsal. Then three mornings in a row on the live task: Manager is fresh
   before 07:00 and armed after the owner's wake line.
