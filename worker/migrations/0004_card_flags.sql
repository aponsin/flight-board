-- The card words the review skips depend on (#C719, Checker on v7): whether the card changes customer-facing text (the language
-- review is skipped when it does not), whether it changes how something looks (the design review runs only when it does), and
-- an explicit list of review phases to skip. NULL means "not said": the probe then applies the rules as they were for a card
-- that never carried the flag (language runs, design is skipped), exactly as the old board did.
ALTER TABLE cards ADD COLUMN customer_text INTEGER CHECK (customer_text IN (0, 1));
ALTER TABLE cards ADD COLUMN look_change INTEGER CHECK (look_change IN (0, 1));
ALTER TABLE cards ADD COLUMN skip TEXT;
