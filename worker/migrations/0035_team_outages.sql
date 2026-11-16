-- team-outages (#C990): the stretches when the probe was silent (nothing written to the store for PROBE_SILENT_MS or more). The store writes a row when the
-- probe comes back: start_at = the last probe post before the silence, end_at = the first one after it. Step clocks (slowWakes, stalledWaits) take the
-- time inside an outage out of a step's waited time; a silence still open is read from the evidence (readView's probe state), not kept here.
-- Additive: a board with no rows reads as "never an outage".
CREATE TABLE IF NOT EXISTS team_outages (
  start_at INTEGER PRIMARY KEY,
  end_at INTEGER NOT NULL
);
