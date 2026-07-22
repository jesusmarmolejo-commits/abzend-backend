-- ═══════════════════════════════════════════════════════
-- MIGRATION 009: Vincular conductores a clientes (flota propia)
-- Ejecuta en: Supabase Dashboard -> SQL Editor
--
-- Razon (Jesus, 2026-07-21): un cliente B2B con suscripcion administra su
-- propia flota; para asignar un repartidor a una ruta necesita que los
-- drivers esten ligados a su clientes.id. Hoy drivers es global (solo
-- user_id -> users). Se agrega drivers.cliente_id (nullable, no rompe a los
-- drivers globales existentes) + policy SELECT del cliente (aditiva;
-- defensa en profundidad, el backend usa service_role que omite RLS).
-- ═══════════════════════════════════════════════════════

-- 1) Columna de vinculo cliente <- driver (nullable)
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS cliente_id uuid REFERENCES clientes(id);

-- 2) Indice para busquedas por cliente
CREATE INDEX IF NOT EXISTS idx_drivers_cliente ON drivers (cliente_id);

-- 3) Policy RLS SELECT: el cliente ve solo sus conductores.
--    (Postgres no tiene CREATE POLICY IF NOT EXISTS -> DROP + CREATE.)
--    Aditiva: NO se toca ninguna policy existente y RLS ya esta habilitado.
DROP POLICY IF EXISTS drivers_client_read ON drivers;
CREATE POLICY drivers_client_read ON drivers
  FOR SELECT
  USING (
    cliente_id IN (SELECT cliente_id FROM users WHERE auth_id = auth.uid())
  );
