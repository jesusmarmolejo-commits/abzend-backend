-- ═══════════════════════════════════════════════════════
-- MIGRATION 011: Conductores — flag active + operator_code unico
-- Ejecuta en: Supabase Dashboard -> SQL Editor
--
-- Razon (Jesus, 2026-07-22): poder habilitar/deshabilitar un repartidor y
-- darle un numero identificador unico (auto-generado) para evitar duplicidad
-- de operadores. El DEFAULT con secuencia asigna el codigo en CUALQUIER alta
-- de driver (cliente-admin o panel-admin) sin tocar codigo; el indice unico
-- lo garantiza global. RLS sin cambios (el backend usa service_role; la
-- policy de lectura del cliente ya expone estas columnas via select *).
-- ═══════════════════════════════════════════════════════

-- 1) Habilitar/deshabilitar
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- 2) Secuencia global para el numero de operador
CREATE SEQUENCE IF NOT EXISTS driver_operator_seq START 1;

-- 3) Columna de codigo de operador
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS operator_code text;

-- 4) DEFAULT auto-generado: OP-00001, OP-00002, ...
ALTER TABLE drivers
  ALTER COLUMN operator_code
  SET DEFAULT ('OP-' || lpad(nextval('driver_operator_seq')::text, 5, '0'));

-- 5) Backfill de los conductores existentes que aun no tienen codigo
UPDATE drivers
  SET operator_code = 'OP-' || lpad(nextval('driver_operator_seq')::text, 5, '0')
  WHERE operator_code IS NULL;

-- 6) Unicidad global (permite nulos)
CREATE UNIQUE INDEX IF NOT EXISTS drivers_operator_code_uidx
  ON drivers (operator_code) WHERE operator_code IS NOT NULL;
