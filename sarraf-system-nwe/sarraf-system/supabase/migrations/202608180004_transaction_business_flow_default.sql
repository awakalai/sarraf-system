-- Let the custody trigger derive the business flow when a writer omits the column.
--
-- A PostgreSQL column default is populated before BEFORE triggers run.  The former `standard`
-- default therefore made an omitted value indistinguishable from a client that explicitly forged
-- `standard`, and valid partner-custody / owner-cashbox inserts were rejected.  Keeping NOT NULL
-- while dropping only the default preserves explicit contradiction detection: omitted values reach
-- the trigger as NULL, are derived from custody fields, and are non-NULL before constraints run.

begin;

alter table public.txs alter column business_flow drop default;

commit;
