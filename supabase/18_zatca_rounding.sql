-- 18: VAT on a document is rounded once per VAT rate (ZATCA BR-S-09 / BR-CO-14), not as the sum of rounded lines.
-- Lines keep their own rounded VAT (BR-KSA-50). Only the document total can move, by at most a halala or two on
-- long invoices, and only for documents posted from now on.
create or replace function compute_lines(doc uuid, fx numeric default 1) returns void
language sql security definer set search_path = public as $$
  update document_lines set
    line_net = round(qty * unit_price * fx) - discount,
    line_vat = round((round(qty * unit_price * fx) - discount) * vat_rate / 100)
  where document_id = doc;
  update documents set
    subtotal = (select coalesce(sum(line_net),0) from document_lines where document_id = doc),
    vat_total = (select coalesce(sum(v), 0) from (select round(sum(line_net) * vat_rate / 100) v
                   from document_lines where document_id = doc group by vat_rate) x)
  where id = doc;
  update documents set total = subtotal + vat_total where id = doc;
$$;
revoke execute on function compute_lines(uuid, numeric) from public, anon, authenticated;
