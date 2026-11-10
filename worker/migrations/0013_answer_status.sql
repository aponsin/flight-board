-- Asks in full (#C725 B2, parity): the owner's answer keeps the button he pressed and the note he wrote beside it, so the page
-- draws "You chose B: <note>", "You asked for help: <note>" as the old board did. Both are NULL on an answer given before this
-- (and on an approval): the page then derives the status from the answer text, as it did.
ALTER TABLE asks ADD COLUMN answer_status TEXT;
ALTER TABLE asks ADD COLUMN answer_note TEXT;
