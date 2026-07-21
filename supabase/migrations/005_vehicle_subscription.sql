-- ═══════════════════════════════════════════════════════
-- MIGRATION 005: Suscripción por vehículo (placas) + tope RBAC
-- Ejecuta en: Supabase Dashboard → SQL Editor
--
-- ADAPTACIONES vs. spec original (esquema real ABZEND):
--   • La tabla de clientes es `clientes` (no `clients`).
--   • El vínculo con Supabase Auth es users.auth_id = auth.uid();
--     el cliente se alcanza vía users.cliente_id → clientes.id.
--     Por eso el RLS NO usa `id = auth.uid()`.
--   • NO se habilita RLS sobre `clientes`: es una tabla existente que
--     los paneles admin leen/escriben con la anon key; habilitar RLS
--     con una sola policy self-select rompería la pantalla de clientes.
--     La protección de vehicle_limit se logra con REVOKE de columna.
--   • El rol NO viaja en el JWT de Supabase (se resuelve por lookup a
--     users en el middleware). Las policies de rol usan EXISTS sobre users.
-- ═══════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. clientes: campos de suscripción
-- ─────────────────────────────────────────────
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS billing_model text NOT NULL DEFAULT 'contract'
    CHECK (billing_model IN ('contract','subscription')),
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('active','past_due','suspended')),
  ADD COLUMN IF NOT EXISTS vehicle_limit integer NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────
-- 2. vehicles (placas de suscripción por cliente)
--    Concepto separado de drivers.license_plate y transport_units.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clientes(id),
  placa          text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);

-- Una placa activa por cliente; permite reactivar histórico (parcial WHERE)
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_client_placa_active_uidx
  ON vehicles (client_id, placa)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_vehicles_client ON vehicles (client_id);

-- ─────────────────────────────────────────────
-- 3. Auditoría de cambios de tope
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_limit_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clientes(id),
  old_limit   integer NOT NULL,
  new_limit   integer NOT NULL,
  changed_by  uuid REFERENCES users(id),
  source      text NOT NULL CHECK (source IN ('webhook','manual')),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- reason obligatorio si el cambio es manual
ALTER TABLE vehicle_limit_changes
  DROP CONSTRAINT IF EXISTS reason_required_if_manual;
ALTER TABLE vehicle_limit_changes
  ADD CONSTRAINT reason_required_if_manual
  CHECK (source <> 'manual' OR (reason IS NOT NULL AND length(trim(reason)) > 0));

CREATE INDEX IF NOT EXISTS idx_vehicle_limit_changes_client
  ON vehicle_limit_changes (client_id, created_at DESC);

-- ─────────────────────────────────────────────
-- 4. Trigger: tope a prueba de condición de carrera
--    FOR UPDATE bloquea la fila del cliente durante la transacción,
--    de modo que dos altas simultáneas no puedan pasar el conteo
--    antes de que la primera confirme.
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_vehicle_limit()
RETURNS trigger AS $$
DECLARE
  active_count integer;
  limit_count  integer;
BEGIN
  SELECT vehicle_limit INTO limit_count
    FROM clientes WHERE id = NEW.client_id FOR UPDATE;

  IF limit_count IS NULL THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND';
  END IF;

  SELECT count(*) INTO active_count
    FROM vehicles WHERE client_id = NEW.client_id AND status = 'active';

  IF active_count >= limit_count THEN
    RAISE EXCEPTION 'VEHICLE_LIMIT_REACHED';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_vehicle_limit ON vehicles;
CREATE TRIGGER trg_enforce_vehicle_limit
  BEFORE INSERT ON vehicles
  FOR EACH ROW WHEN (NEW.status = 'active')
  EXECUTE FUNCTION enforce_vehicle_limit();

-- ─────────────────────────────────────────────
-- 5. Protección de vehicle_limit a nivel columna
--    Ni el cliente ni ningún usuario con anon key (rol `authenticated`)
--    puede escribir vehicle_limit directo a Supabase. Solo el backend,
--    que usa service_role, puede actualizarlo (y audita cada cambio).
--
--    OJO (gotcha Postgres): un REVOKE UPDATE (vehicle_limit) NO surte
--    efecto mientras exista el GRANT UPDATE a nivel tabla (default de
--    Supabase para authenticated/anon): el grant amplio cubre todas las
--    columnas. Hay que quitar el UPDATE tabla-completa y re-otorgarlo
--    columna por columna, excepto vehicle_limit.
-- ─────────────────────────────────────────────
REVOKE UPDATE ON clientes FROM authenticated, anon;

-- Re-otorga UPDATE en todas las columnas EXCEPTO vehicle_limit, solo a
-- authenticated (el panel-admin corre como ese rol; anon = sin sesión).
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ')
  INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'clientes'
    AND column_name <> 'vehicle_limit';
  EXECUTE format('GRANT UPDATE (%s) ON clientes TO authenticated', cols);
END $$;

-- ─────────────────────────────────────────────
-- 6. RLS sobre las tablas NUEVAS (defensa en profundidad para el
--    path de anon key; el backend usa service_role y las omite).
-- ─────────────────────────────────────────────
ALTER TABLE vehicles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_limit_changes ENABLE ROW LEVEL SECURITY;

-- El cliente ve e inserta solo sus propios vehículos.
-- (client_id es clientes.id, resuelto vía users.cliente_id.)
DROP POLICY IF EXISTS vehicles_select_own ON vehicles;
CREATE POLICY vehicles_select_own ON vehicles
  FOR SELECT USING (
    client_id IN (SELECT cliente_id FROM users WHERE auth_id = auth.uid())
  );

DROP POLICY IF EXISTS vehicles_insert_own ON vehicles;
CREATE POLICY vehicles_insert_own ON vehicles
  FOR INSERT WITH CHECK (
    client_id IN (SELECT cliente_id FROM users WHERE auth_id = auth.uid())
  );

-- El staff comercial/admin puede ver la auditoría (path anon key).
-- El rol se resuelve por lookup a users, no por claim del JWT.
DROP POLICY IF EXISTS vehicle_limit_changes_staff_read ON vehicle_limit_changes;
CREATE POLICY vehicle_limit_changes_staff_read ON vehicle_limit_changes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE auth_id = auth.uid()
        AND role IN ('admin','gerente_comercial')
    )
  );
