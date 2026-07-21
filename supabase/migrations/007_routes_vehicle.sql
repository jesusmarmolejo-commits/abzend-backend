-- ═══════════════════════════════════════════════════════
-- MIGRATION 007: Ruteo por suscripción — vínculo route → vehicle
-- Ejecuta en: Supabase Dashboard → SQL Editor
--
-- Decisión (Jesús, 2026-07-21): la ruta se liga a la PLACA DE SUSCRIPCIÓN
-- (tabla vehicles), no a transport_units. Se mantiene routes.unit_id para
-- compatibilidad con la flota operativa existente.
--
-- Vocabulario de status real de routes: default 'CREADA'. Se usa el ciclo
-- CREADA → EN_RUTA → COMPLETADA (+ CANCELADA). type default 'local'.
-- ═══════════════════════════════════════════════════════

ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id);

CREATE INDEX IF NOT EXISTS idx_routes_vehicle ON routes (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_route_items_route ON route_items (route_id);
