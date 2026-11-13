-- What a card removes (#C866, the owner's "lean, delete" of 2026-11-04): an optional one-line `removes` on a card, shown in its Details on the page.
-- Nullable and additive: a card written before has none, and the page draws it as before.
ALTER TABLE cards ADD COLUMN removes TEXT;
