create table if not exists public.earnings_event_overrides (
  symbol text primary key check (symbol = upper(trim(symbol))),
  earnings_date date not null,
  report_hour text not null default 'tbd' check (report_hour in ('bmo', 'amc', 'dmh', 'tbd')),
  fiscal_quarter integer,
  fiscal_year integer,
  eps_estimate numeric,
  eps_actual numeric,
  revenue_estimate numeric,
  revenue_actual numeric,
  source_url text not null,
  source_note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.earnings_event_overrides enable row level security;
revoke all on table public.earnings_event_overrides from anon, authenticated;
grant select on table public.earnings_event_overrides to service_role;

insert into public.earnings_event_overrides (
  symbol,
  earnings_date,
  report_hour,
  fiscal_quarter,
  fiscal_year,
  eps_estimate,
  eps_actual,
  revenue_estimate,
  revenue_actual,
  source_url,
  source_note,
  is_active,
  updated_at
)
values (
  'LITE',
  '2026-11-02',
  'bmo',
  1,
  2027,
  4.14,
  4.57,
  1250000000,
  1262600000,
  'https://investor.lumentum.com/financial-news-releases/news-details/2026/Lumentum-Announces-First-Quarter-of-Fiscal-Year-2027-Financial-Results/default.aspx',
  'Q1 FY2027 results were released early with the Marvell transaction announcement.',
  true,
  now()
)
on conflict (symbol) do update set
  earnings_date = excluded.earnings_date,
  report_hour = excluded.report_hour,
  fiscal_quarter = excluded.fiscal_quarter,
  fiscal_year = excluded.fiscal_year,
  eps_estimate = excluded.eps_estimate,
  eps_actual = excluded.eps_actual,
  revenue_estimate = excluded.revenue_estimate,
  revenue_actual = excluded.revenue_actual,
  source_url = excluded.source_url,
  source_note = excluded.source_note,
  is_active = excluded.is_active,
  updated_at = now();
