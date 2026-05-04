-- Sequence backing the human-facing order_number on `orders`.
--
-- Values are formatted into "YYYY-MM-NNNNN" at insert time using
--   to_char(now() AT TIME ZONE 'Europe/Sofia', 'YYYY-MM') || '-' ||
--   lpad(nextval('orders_order_number_seq')::text, 5, '0')
--
-- The sequence is monotonically increasing for life — it does NOT reset each
-- month. The "YYYY-MM-" prefix gives orders a human-readable monthly grouping
-- without sacrificing the global-uniqueness guarantee that the unique index
-- on orders.order_number requires. After 99,999 lifetime orders the suffix
-- naturally widens to 6 digits via lpad's minimum-width semantics.
--
-- Why a sequence instead of a serial column on `orders`:
--   - The order number is composed of TWO parts (date + counter), so it can't
--     be a column default. It needs a function call site (the API insert).
--   - We want ONE counter shared across all orders, regardless of the
--     timezone or month boundary.
--   - Sequences are crash-safe and never reuse numbers (gaps from rolled-back
--     transactions are fine — the spec says order_number is opaque to the
--     customer beyond ordering).
CREATE SEQUENCE IF NOT EXISTS orders_order_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
