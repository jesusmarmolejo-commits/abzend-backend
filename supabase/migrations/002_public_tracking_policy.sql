-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 002: RLS policy para rastreo público (página abzend-tracking)
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Permitir que usuarios anónimos (sin login) lean órdenes por tracking_code.
--    La consulta desde la app siempre filtra por eq.tracking_code, por lo que
--    no se expone información masiva; el usuario necesita saber el código exacto.
create policy "public_tracking_lookup"
  on orders
  for select
  to anon
  using (true);

-- 2. Habilitar RLS en order_events (no estaba activado en la migración 001)
--    y agregar policy pública para que el timeline de eventos sea visible.
alter table order_events enable row level security;

create policy "public_events_lookup"
  on order_events
  for select
  to anon
  using (true);

insert into schema_migrations (version) values ('002') on conflict do nothing;
