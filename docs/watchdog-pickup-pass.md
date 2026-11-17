# Watchdog task: the pickup pass (#C870)

New text for the scheduled task the agent watchdog, added to its prompt after its own checks. The owner installs it
in the task; nothing else in this repository reads it.

---

## Pickup pass (every run)

For each role on the roster in `board.config.json`:

1. Read its row with `list_sessions` (or `get_session` for `remoteControlState`): `state` is "idle" or "working".
2. Read its Messages tokens with `get_usage` (none listed is 0).
3. `reset` is true when the role posted "resetting after this" (or its context was cleared on purpose) and no pickup has
   answered since. `pickedUp` is true when a `/pickup <Role>` ran since that reset. `watchRunning` is true when a
   dispatch watch (`wake-watch.mjs`) is armed for it. Take these from the board's thread and the role's own last lines;
   if you cannot tell, leave the field out (a missing field means "not true").
4. Collect one row per role and run, as one Bash call with nothing around it:

   `node ~/.flight-board/current/scripts/pickup-watch.mjs --pass '[{"role":"<Role>","state":"idle","tokens":0,"reset":true,"pickedUp":false,"watchRunning":false,"remoteControl":"on"}, …]'`

5. It prints a JSON list. Do exactly what it lists, nothing else, once each:
   - `{"do":"send_message"}`: `send_message` to that role's session with exactly its `text`.
   - `{"do":"set_remote_control","on":true}`: `set_remote_control` on for that role's session.
6. An empty list means do nothing. Never send a `/pickup` yourself that the list did not name, and never send one to a
   role that is working: its reset turn may still be running.
