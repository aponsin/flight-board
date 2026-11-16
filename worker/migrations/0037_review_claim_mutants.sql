-- A review claim carries the mutant count the reviewer will run (#C1115): the review's ETA adds count x seconds per mutant, and a review 30 minutes past its ETA
-- wakes Manager with the reviewer's progress line. All four columns are optional and additive: a claim with none reads as before (no mutants, no progress line).
ALTER TABLE review_claims ADD COLUMN mutants INTEGER;
ALTER TABLE review_claims ADD COLUMN mutant_sec INTEGER;
ALTER TABLE review_claims ADD COLUMN progress TEXT;
ALTER TABLE review_claims ADD COLUMN progress_at INTEGER;
