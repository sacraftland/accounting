-- Migration 03 — pin search_path on every non-definer function (Supabase advisor 0011).
alter function public.set_updated_at() set search_path = public;
alter function public.check_entry_balanced() set search_path = public;
alter function public.guard_posted_entry() set search_path = public;
alter function public.guard_posted_lines() set search_path = public;
alter function public.next_number(uuid, text) set search_path = public;
alter function public.guard_posted_document() set search_path = public;
alter function public.acct(uuid, text) set search_path = public;
alter function public.is_client() set search_path = public;
alter function public.guard_client_document() set search_path = public;
alter function public.guard_client_doc_line() set search_path = public;
alter function public.guard_client_payment() set search_path = public;
alter function public.guard_client_allocation() set search_path = public;
