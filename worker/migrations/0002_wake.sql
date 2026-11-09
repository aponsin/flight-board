-- The wake on the store (#C719, DATA.md row 4; brief "Spike result" rules). The probe asks every 20 s; the store opens ONE
-- batch for what the owner wrote and Manager has not read; Manager's typed read marks it taken. Every send's result lands here.
ALTER TABLE wake ADD COLUMN batch_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wake ADD COLUMN taken_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wake ADD COLUMN last_send_at INTEGER;
ALTER TABLE wake ADD COLUMN last_send_batch TEXT;
ALTER TABLE wake ADD COLUMN last_send_ok INTEGER CHECK (last_send_ok IN (0, 1));
ALTER TABLE wake ADD COLUMN last_send_reason TEXT;
ALTER TABLE wake ADD COLUMN last_send_fix TEXT;
ALTER TABLE wake ADD COLUMN told_reason TEXT;

-- An answer is "for Manager" until Manager's read takes it.
ALTER TABLE asks ADD COLUMN answer_taken_at INTEGER;
