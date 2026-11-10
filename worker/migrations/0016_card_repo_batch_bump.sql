-- What each card's expected version is worked out from (#C731 B4b, board parity stage B): the repository it lives in (a card of another
-- repository is not in the team's ship queue), the batch the lead marks to ship it with others in one version, and its bump
-- (patch, minor or major). All nullable and additive: a card written before has none (the team's repository, no batch, a patch).
ALTER TABLE cards ADD COLUMN repo TEXT;
ALTER TABLE cards ADD COLUMN batch TEXT;
ALTER TABLE cards ADD COLUMN bump TEXT;
