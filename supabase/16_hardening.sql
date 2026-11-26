-- =====================================================================
-- Migration 16 — tighten table privileges
--  Supabase grants every new table to anon and authenticated by default.
--  Row-level security already blocked every row, but the grants themselves
--  should not exist:
--   • anon (visitors without an account) gets no table or view at all —
--     the customer portal works through its own functions
--   • signed-in users keep read/write (still filtered by RLS), but lose
--     TRUNCATE / TRIGGER / REFERENCES, which they never need
--   • future tables are no longer granted to anon automatically
-- =====================================================================
revoke all on all tables in schema public from anon;
revoke truncate, trigger, references on all tables in schema public from authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke truncate, trigger, references on tables from authenticated;
