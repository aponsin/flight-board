-- What a flight-board card touches (#C1169): `contract` is one line naming the principle numbers and DATA.md rows or definitions the card touches, and
-- `changes_definition` says whether the card changes one of them (1) or not (0). Both nullable and additive: a card written before has neither, and a product card needs neither.
ALTER TABLE cards ADD COLUMN contract TEXT;
ALTER TABLE cards ADD COLUMN changes_definition INTEGER;
