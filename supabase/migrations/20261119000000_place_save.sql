-- Place persistence (ticket 10): the whole Place save (Canvas + last 5,000
-- Placement History entries) as one gzipped JSON row, overwritten at most
-- every 30s by AramisJonesApi. Row 1 is the live save; row 2 keeps a corrupt
-- save aside so it is never overwritten.
create table if not exists public.place_save (
  id        smallint primary key check (id in (1, 2)),
  save_gzip text not null,                 -- base64 of gzip(JSON.stringify(PlaceSave))
  saved_at  timestamptz not null default now()
);

-- RLS on with no policies: the publishable key and browsers get nothing.
-- Only the API's server-side secret key (which bypasses RLS) can read or write.
alter table public.place_save enable row level security;
revoke all on table public.place_save from anon, authenticated;
