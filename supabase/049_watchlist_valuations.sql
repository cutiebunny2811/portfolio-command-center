begin;

create table if not exists public.company_valuation_snapshots (
  symbol text primary key,
  cik text not null,
  company_name text not null,
  sic integer,
  sic_description text,
  valuation jsonb not null,
  sec_filed_at date,
  source text not null default 'sec_companyfacts',
  explanation text,
  explanation_model text,
  explanation_generated_at timestamptz,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_valuation_snapshots_symbol_check check (symbol = upper(symbol))
);

comment on table public.company_valuation_snapshots is
  'Shared cache of deterministic public-company valuations built from SEC Company Facts. AI explanations are optional and never provide the canonical fair-value calculation.';

alter table public.company_valuation_snapshots enable row level security;

drop policy if exists company_valuation_snapshots_authenticated_read on public.company_valuation_snapshots;
create policy company_valuation_snapshots_authenticated_read
  on public.company_valuation_snapshots for select to authenticated
  using (true);

grant select on public.company_valuation_snapshots to authenticated;

commit;

