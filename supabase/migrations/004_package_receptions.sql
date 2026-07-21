-- ═══════════════════════════════════════════════════════
-- MIGRATION 004: Recepción de paquetes vía escaneo QR (repartidor)
-- Ejecuta en: Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════

-- NOTA: no existe tabla `stations` en el esquema actual (001_schema.sql).
-- "station" es un rol dentro de `users`. Se omite la FK a `stations(id)`
-- y se mantiene `station_id` como UUID libre por si se crea esa tabla a futuro.

CREATE TABLE IF NOT EXISTS package_receptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_code TEXT NOT NULL,
  driver_id UUID NOT NULL REFERENCES drivers(id),
  station_id UUID,
  status TEXT NOT NULL DEFAULT 'pending_station_validation'
    CHECK (status IN ('pending_station_validation', 'confirmed', 'rejected')),
  driver_scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  station_validated_at TIMESTAMPTZ,
  station_user_id UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_package_receptions_driver ON package_receptions(driver_id);
CREATE INDEX IF NOT EXISTS idx_package_receptions_status ON package_receptions(status);
CREATE INDEX IF NOT EXISTS idx_package_receptions_qr ON package_receptions(qr_code);

ALTER TABLE package_receptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "drivers_own_receptions" ON package_receptions;
CREATE POLICY "drivers_own_receptions" ON package_receptions
  FOR ALL USING (driver_id = (SELECT id FROM drivers WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "station_can_validate" ON package_receptions;
CREATE POLICY "station_can_validate" ON package_receptions
  FOR UPDATE USING (true) WITH CHECK (status IN ('confirmed', 'rejected'));

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_package_receptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_package_receptions_updated_at ON package_receptions;
CREATE TRIGGER trg_package_receptions_updated_at
  BEFORE UPDATE ON package_receptions
  FOR EACH ROW
  EXECUTE FUNCTION update_package_receptions_updated_at();

-- Política admin global (regla obligatoria del workspace)
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE POLICY "admin_all_package_receptions" ON package_receptions FOR ALL USING (is_admin())';
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
