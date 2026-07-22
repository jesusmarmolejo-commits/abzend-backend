-- ═══════════════════════════════════════════════════════
-- MIGRATION 008: RLS — el chofer puede leer sus FTL (transport_orders)
-- Ejecuta en: Supabase Dashboard → SQL Editor
--
-- Contexto: la app del repartidor (Kotlin) lee Supabase directo con la
-- sesión del chofer (rol authenticated). Para `orders` ya existe la policy
-- drivers_assigned_orders; los FTL (transport_orders) no tenían equivalente,
-- por eso un FTL asignado no aparecía aunque el driver_id fuera correcto.
--
-- Aditiva: NO cambia el estado ENABLE/DISABLE de RLS de la tabla (no rompe
-- a otros consumidores). Si RLS está activo, otorga la lectura al chofer;
-- si está inactivo, la policy es inerte (la lectura ya funcionaría).
-- ═══════════════════════════════════════════════════════

DROP POLICY IF EXISTS drivers_own_transport_orders ON transport_orders;
CREATE POLICY drivers_own_transport_orders ON transport_orders
  FOR SELECT USING (
    driver_id IN (
      SELECT d.id FROM drivers d
      JOIN users u ON u.id = d.user_id
      WHERE u.auth_id = auth.uid()
    )
  );
