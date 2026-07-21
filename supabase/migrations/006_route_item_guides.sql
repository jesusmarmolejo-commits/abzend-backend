-- ═══════════════════════════════════════════════════════
-- MIGRATION 006: Multi-guía por parada (route_item_guides)
-- Ejecuta en: Supabase Dashboard → SQL Editor
--
-- ADAPTACIONES vs. spec original (esquema real ABZEND):
--   • La spec cuelga las guías de `route_stops`, que NO existe.
--     En este esquema una "parada" de ruta es una fila de `route_items`
--     (liga una `route` a una order/transport_order). Por eso la tabla
--     de enlace apunta a route_items(id), no a route_stops(id).
--   • `route_items` ya era 1 fila por orden; con esta tabla una misma
--     parada (route_item) puede agrupar varias guías.
--   • pod_id referencia proof_of_delivery(id) (tabla existente).
--   • Sin estado propio: el lifecycle vive en orders/transport_orders.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS route_item_guides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_item_id uuid NOT NULL REFERENCES route_items(id) ON DELETE CASCADE,
  order_type    text NOT NULL CHECK (order_type IN ('paqueteria','ltl','ftl')),
  order_id      uuid NOT NULL,
  guide_code    text NOT NULL,          -- denormalizado para mostrar/buscar sin join
  pod_id        uuid REFERENCES proof_of_delivery(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- No duplicar la misma orden dentro de una parada
CREATE UNIQUE INDEX IF NOT EXISTS route_item_guides_no_dup
  ON route_item_guides (route_item_id, order_type, order_id);

CREATE INDEX IF NOT EXISTS idx_route_item_guides_item
  ON route_item_guides (route_item_id);

-- Búsqueda por código de guía (denormalizado)
CREATE INDEX IF NOT EXISTS idx_route_item_guides_code
  ON route_item_guides (guide_code);

-- El anti-doble-ruteo (una guía no puede estar en dos rutas activas a la
-- vez) se valida en el endpoint, no con constraint: requiere unir contra
-- routes.status y es riesgo operativo, no de integridad de datos.

ALTER TABLE route_item_guides ENABLE ROW LEVEL SECURITY;

-- El cliente ve las guías de las paradas de sus propias rutas.
-- Una ruta es "suya" si tiene items ligados a orders/transport_orders
-- cuyo client_id mapea a su cliente vía users.cliente_id.
-- El backend (service_role) omite RLS; esto es defensa en profundidad
-- para el path de anon key en el panel-cliente.
DROP POLICY IF EXISTS route_item_guides_client_read ON route_item_guides;
CREATE POLICY route_item_guides_client_read ON route_item_guides
  FOR SELECT USING (
    order_type = 'paqueteria' AND order_id IN (
      SELECT o.id FROM orders o
      JOIN users u ON u.id = o.client_id
      WHERE u.auth_id = auth.uid()
    )
    OR order_type IN ('ltl','ftl') AND order_id IN (
      SELECT t.id FROM transport_orders t
      JOIN users u ON u.id = t.client_id
      WHERE u.auth_id = auth.uid()
    )
  );
