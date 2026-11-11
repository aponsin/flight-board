-- agent-queues-owner-order (#C871): who placed a card in its agent's queue and when. The owner's placement outranks an agent's: once the owner has
-- set a card's queue_pos, the Worker refuses an agent's write to it, and the page says "order set by the owner". queue_pos itself exists
-- (0014_card_fields.sql). Additive and nullable: a card written before has neither, which reads as "no one placed it".
ALTER TABLE cards ADD COLUMN queue_set_by TEXT;
ALTER TABLE cards ADD COLUMN queue_set_at INTEGER;
