import { supabaseAdmin } from '../services/supabase.js';

// Estados de ruta que cuentan como "activa" para el anti-doble-ruteo.
// Vocabulario real en DB (routes.status): CREADA → EN_RUTA → COMPLETADA/CANCELADA.
// "Activa" = aún no terminal (una guía no puede estar en dos rutas vivas).
const ACTIVE_ROUTE_STATUSES = ['CREADA', 'EN_RUTA'];

// ─────────────────────────────────────────────────────────────
// Resolver de orden por guide_code — misma lógica que
// GET /v1/orders/:trackingCode/detail (orderDetailController).
// Devuelve { order_type, order_id, client_id } o null si no existe.
// client_id es users.id (dueño de la orden).
// ─────────────────────────────────────────────────────────────
async function resolveOrderByGuide(guideCode) {
  // 1) orders (PAQUETERIA=ABZ-, LTL=TRK-)
  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, client_id, tracking_code')
    .eq('tracking_code', guideCode)
    .maybeSingle();

  if (order) {
    const orderType = guideCode.startsWith('TRK-') ? 'ltl' : 'paqueteria';
    return { order_type: orderType, order_id: order.id, client_id: order.client_id };
  }

  // 2) transport_orders (FTL) — por tracking_code o por id (UUID)
  let query = supabaseAdmin
    .from('transport_orders')
    .select('id, client_id, tracking_code')
    .eq('tracking_code', guideCode);

  let { data: to } = await query.maybeSingle();

  if (!to && /^[0-9a-f-]{36}$/i.test(guideCode)) {
    const byId = await supabaseAdmin
      .from('transport_orders')
      .select('id, client_id, tracking_code')
      .eq('id', guideCode)
      .maybeSingle();
    to = byId.data;
  }

  if (to) {
    return { order_type: 'ftl', order_id: to.id, client_id: to.client_id };
  }

  return null;
}

// Cliente (users.id) dueño de un route_item, según la orden que referencia.
async function resolveRouteItemClient(routeItem) {
  if (routeItem.order_id) {
    const { data } = await supabaseAdmin
      .from('orders').select('client_id').eq('id', routeItem.order_id).maybeSingle();
    return data?.client_id ?? null;
  }
  if (routeItem.transport_order_id) {
    const { data } = await supabaseAdmin
      .from('transport_orders').select('client_id').eq('id', routeItem.transport_order_id).maybeSingle();
    return data?.client_id ?? null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// POST /v1/route-stops/:stopId/guides
// stopId = route_items.id (la "parada" de la ruta).
// body { order_type, guide_code }
// Valida: existencia, ownership (mismo cliente que la parada),
// no-duplicado y no-doble-ruteo. Inserta en route_item_guides.
// ─────────────────────────────────────────────────────────────
export const addRouteGuide = async (req, res) => {
  try {
    const routeItemId = req.params.stopId;
    const guideCode = String(req.body.guide_code || '').trim();
    if (!guideCode) return res.status(400).json({ error: 'guide_code es requerido' });

    // La parada (route_item) debe existir.
    const { data: routeItem, error: riErr } = await supabaseAdmin
      .from('route_items')
      .select('id, route_id, order_id, transport_order_id')
      .eq('id', routeItemId)
      .single();
    if (riErr || !routeItem) return res.status(404).json({ error: 'Parada (route_item) no encontrada' });

    // Resolver la orden por su guía.
    const resolved = await resolveOrderByGuide(guideCode);
    if (!resolved) return res.status(404).json({ error: 'Guía no encontrada' });

    // Si el body trae order_type, debe coincidir con el resuelto.
    if (req.body.order_type && req.body.order_type !== resolved.order_type) {
      return res.status(400).json({
        error: 'ORDER_TYPE_MISMATCH',
        resolved_type: resolved.order_type,
      });
    }

    // Ownership: la guía debe ser del mismo cliente que la parada.
    const stopClientId = await resolveRouteItemClient(routeItem);
    if (stopClientId && resolved.client_id && stopClientId !== resolved.client_id) {
      return res.status(403).json({ error: 'OWNERSHIP_MISMATCH' });
    }

    // No-duplicado dentro de la misma parada.
    const { data: dup } = await supabaseAdmin
      .from('route_item_guides')
      .select('id')
      .eq('route_item_id', routeItemId)
      .eq('order_type', resolved.order_type)
      .eq('order_id', resolved.order_id)
      .maybeSingle();
    if (dup) return res.status(409).json({ error: 'GUIDE_ALREADY_IN_STOP' });

    // No-doble-ruteo: la guía no puede estar en otra ruta activa.
    const { data: existing } = await supabaseAdmin
      .from('route_item_guides')
      .select('id, route_item:route_items!inner(route_id, route:routes!inner(id, status))')
      .eq('order_type', resolved.order_type)
      .eq('order_id', resolved.order_id);

    const inActiveRoute = (existing || []).some((g) => {
      const route = g.route_item?.route;
      return route && route.id !== routeItem.route_id && ACTIVE_ROUTE_STATUSES.includes(route.status);
    });
    if (inActiveRoute) {
      return res.status(409).json({ error: 'GUIDE_ALREADY_ROUTED' });
    }

    const { data, error } = await supabaseAdmin
      .from('route_item_guides')
      .insert({
        route_item_id: routeItemId,
        order_type: resolved.order_type,
        order_id: resolved.order_id,
        guide_code: guideCode,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'GUIDE_ALREADY_IN_STOP' });
      throw error;
    }

    return res.status(201).json({ guide: data });
  } catch (err) {
    console.error('addRouteGuide error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /v1/route-stops/:stopId/guides — guías de una parada.
// ─────────────────────────────────────────────────────────────
export const getRouteGuides = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('route_item_guides')
      .select('id, order_type, order_id, guide_code, pod_id, created_at')
      .eq('route_item_id', req.params.stopId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return res.json({ guides: data || [] });
  } catch (err) {
    console.error('getRouteGuides error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /v1/route-stops/:stopId/guides/:guideLinkId — quitar guía.
// ─────────────────────────────────────────────────────────────
export const removeRouteGuide = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('route_item_guides')
      .delete()
      .eq('id', req.params.guideLinkId)
      .eq('route_item_id', req.params.stopId)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Guía de parada no encontrada' });
    return res.json({ removed: data });
  } catch (err) {
    console.error('removeRouteGuide error:', err);
    return res.status(500).json({ error: err.message });
  }
};
