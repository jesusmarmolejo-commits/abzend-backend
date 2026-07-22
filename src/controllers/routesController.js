import { supabaseAdmin } from '../services/supabase.js';

// ─────────────────────────────────────────────────────────────
// Vocabulario de status de ruta (real en DB: default 'CREADA').
// ─────────────────────────────────────────────────────────────
export const ROUTE_STATUS = {
  CREATED: 'CREADA',
  ACTIVE: 'EN_RUTA',
  DONE: 'COMPLETADA',
  CANCELLED: 'CANCELADA',
};
const VALID_STATUSES = Object.values(ROUTE_STATUS);
// Transiciones permitidas
const NEXT_STATUS = {
  CREADA: ['EN_RUTA', 'CANCELADA'],
  EN_RUTA: ['COMPLETADA', 'CANCELADA'],
  COMPLETADA: [],
  CANCELADA: [],
};

// Estados terminales de orden (paquetería/LTL usan el enum order_status)
const TERMINAL_ORDER_STATUS = ['delivered', 'failed', 'cancelled'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
async function resolveClienteId(userId) {
  const { data } = await supabaseAdmin
    .from('users').select('cliente_id').eq('id', userId).single();
  return data?.cliente_id ?? null;
}

// cliente (clientes.id) dueño de un usuario dado (users.id)
async function clienteOfUser(userId) {
  const { data } = await supabaseAdmin
    .from('users').select('cliente_id').eq('id', userId).single();
  return data?.cliente_id ?? null;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Resuelve una guía → { order_type, order_id, transport_order_id, client_id, lat, lng, status }
// Misma detección que orderDetailController / routeGuidesController.
async function resolveOrder(guideCode) {
  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, client_id, dest_lat, dest_lng, status, tracking_code')
    .eq('tracking_code', guideCode)
    .maybeSingle();

  if (order) {
    const order_type = guideCode.startsWith('TRK-') ? 'ltl' : 'paqueteria';
    return {
      order_type,
      order_id: order.id,
      transport_order_id: null,
      client_id: order.client_id,
      lat: order.dest_lat,
      lng: order.dest_lng,
      status: order.status,
      item_type: 'paquete',
    };
  }

  let { data: to } = await supabaseAdmin
    .from('transport_orders')
    .select('id, client_id, status, tracking_code')
    .eq('tracking_code', guideCode)
    .maybeSingle();

  if (!to && /^[0-9a-f-]{36}$/i.test(guideCode)) {
    const byId = await supabaseAdmin
      .from('transport_orders')
      .select('id, client_id, status, tracking_code')
      .eq('id', guideCode)
      .maybeSingle();
    to = byId.data;
  }

  if (to) {
    // FTL: sin dest_lat/lng propio (sus paradas viven en `stops`); Fase 1 sin coords.
    return {
      order_type: 'ftl',
      order_id: null,
      transport_order_id: to.id,
      client_id: to.client_id,
      lat: null,
      lng: null,
      status: to.status,
      item_type: 'transporte',
    };
  }

  return null;
}

// Devuelve la ruta si pertenece al cliente (vía vehicle.client_id), o null.
async function getOwnedRoute(routeId, clienteId) {
  const { data: route } = await supabaseAdmin
    .from('routes').select('*').eq('id', routeId).maybeSingle();
  if (!route) return null;
  if (!route.vehicle_id) return null;
  const { data: veh } = await supabaseAdmin
    .from('vehicles').select('client_id').eq('id', route.vehicle_id).maybeSingle();
  if (!veh || veh.client_id !== clienteId) return null;
  return route;
}

const genRouteCode = () =>
  'RT-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

// Coordenadas + estado + datos legibles (tracking/dirección/destinatario) de un
// route_item, según su orden ancla. Sirve para mostrar la parada en el builder.
async function itemGeoAndStatus(item) {
  if (item.order_id) {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('tracking_code, dest_address, recipient_name, dest_lat, dest_lng, status')
      .eq('id', item.order_id).maybeSingle();
    return {
      lat: data?.dest_lat ?? null,
      lng: data?.dest_lng ?? null,
      terminal: data ? TERMINAL_ORDER_STATUS.includes(data.status) : false,
      order_status: data?.status ?? null,
      tracking_code: data?.tracking_code ?? null,
      address: data?.dest_address ?? null,
      recipient: data?.recipient_name ?? null,
    };
  }
  if (item.transport_order_id) {
    const { data } = await supabaseAdmin
      .from('transport_orders').select('tracking_code, ruta, status').eq('id', item.transport_order_id).maybeSingle();
    // FTL sin coords en Fase 1; su "dirección" es la ruta textual.
    return {
      lat: null, lng: null, terminal: false, order_status: data?.status ?? null,
      tracking_code: data?.tracking_code ?? null, address: data?.ruta ?? null, recipient: null,
    };
  }
  return { lat: null, lng: null, terminal: false, order_status: null, tracking_code: null, address: null, recipient: null };
}

// ─────────────────────────────────────────────────────────────
// POST /v1/routes — crea una ruta para el cliente y le asigna un vehículo.
// body { vehicle_id, date?, driver_id?, origin_station?, dest_station?, type?, notes? }
// ─────────────────────────────────────────────────────────────
export const createRoute = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });

    const vehicleId = req.body.vehicle_id;
    if (!vehicleId) return res.status(400).json({ error: 'vehicle_id es requerido' });

    // El vehículo debe ser del cliente y estar activo.
    const { data: veh } = await supabaseAdmin
      .from('vehicles').select('id, client_id, status').eq('id', vehicleId).maybeSingle();
    if (!veh || veh.client_id !== clienteId) {
      return res.status(403).json({ error: 'El vehículo no pertenece a tu cuenta' });
    }
    if (veh.status !== 'active') {
      return res.status(409).json({ error: 'El vehículo no está activo' });
    }

    const insert = {
      route_code: genRouteCode(),
      type: req.body.type || 'local',
      status: ROUTE_STATUS.CREATED,
      vehicle_id: vehicleId,
      driver_id: req.body.driver_id || null,
      origin_station: req.body.origin_station || null,
      dest_station: req.body.dest_station || null,
      notes: req.body.notes || null,
      created_by: req.user.id,
    };
    if (req.body.date) insert.date = req.body.date;

    const { data, error } = await supabaseAdmin
      .from('routes').insert(insert).select().single();
    if (error) throw error;

    return res.status(201).json({ route: data });
  } catch (err) {
    console.error('createRoute error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /v1/routes — rutas del cliente con vehículo y avance.
// ─────────────────────────────────────────────────────────────
export const listRoutes = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });

    // Vehículos del cliente → rutas de esos vehículos.
    const { data: vehicles } = await supabaseAdmin
      .from('vehicles').select('id, placa').eq('client_id', clienteId);
    const vehIds = (vehicles || []).map((v) => v.id);
    const placaById = Object.fromEntries((vehicles || []).map((v) => [v.id, v.placa]));
    if (vehIds.length === 0) return res.json({ routes: [] });

    const { data: routes, error } = await supabaseAdmin
      .from('routes')
      .select('*')
      .in('vehicle_id', vehIds)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Avance por ruta (conteo de paradas y cerradas).
    const result = [];
    for (const r of routes || []) {
      const { data: items } = await supabaseAdmin
        .from('route_items').select('id, order_id, transport_order_id').eq('route_id', r.id);
      let closed = 0;
      for (const it of items || []) {
        const g = await itemGeoAndStatus(it);
        if (g.terminal) closed++;
      }
      result.push({
        ...r,
        placa: placaById[r.vehicle_id] || null,
        stops_total: (items || []).length,
        stops_closed: closed,
      });
    }

    return res.json({ routes: result });
  } catch (err) {
    console.error('listRoutes error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /v1/routes/:id — detalle con paradas ordenadas y estado derivado.
// ─────────────────────────────────────────────────────────────
// Devuelve las guias de una parada (la principal + las agrupadas en
// route_item_guides) con sus bultos, y el total de bultos de la parada.
async function stopGuidesWithBultos(routeItem) {
  const guideRefs = [];
  const seenOrderIds = new Set();

  if (routeItem.order_id) {
    guideRefs.push({ order_id: routeItem.order_id, guide_link_id: null });
    seenOrderIds.add(routeItem.order_id);
  }

  const { data: guidesData } = await supabaseAdmin
    .from('route_item_guides')
    .select('id, order_type, order_id')
    .eq('route_item_id', routeItem.id)
    .order('created_at', { ascending: true });

  for (const row of guidesData || []) {
    if ((row.order_type === 'paqueteria' || row.order_type === 'ltl') && !seenOrderIds.has(row.order_id)) {
      guideRefs.push({ order_id: row.order_id, guide_link_id: row.id });
      seenOrderIds.add(row.order_id);
    }
  }

  const guides = [];
  let stopBultosTotal = 0;

  for (const ref of guideRefs) {
    const { data: orderData } = await supabaseAdmin
      .from('orders')
      .select('tracking_code, recipient_name, dest_address, bultos(id, tipo, cantidad, descripcion)')
      .eq('id', ref.order_id)
      .maybeSingle();

    const bultos = orderData?.bultos || [];
    const bultosTotal = bultos.reduce((sum, b) => sum + (parseInt(b.cantidad, 10) || 0), 0);

    guides.push({
      guide_link_id: ref.guide_link_id,
      order_id: ref.order_id,
      tracking_code: orderData?.tracking_code ?? null,
      recipient: orderData?.recipient_name ?? null,
      address: orderData?.dest_address ?? null,
      bultos,
      bultos_total: bultosTotal,
    });
    stopBultosTotal += bultosTotal;
  }

  return { guides, bultos_total: stopBultosTotal };
}

export const getRoute = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });

    const route = await getOwnedRoute(req.params.id, clienteId);
    if (!route) return res.status(404).json({ error: 'Ruta no encontrada' });

    const { data: items } = await supabaseAdmin
      .from('route_items')
      .select('id, item_type, order_id, transport_order_id, stop_order, distance_km, estimated_arrival')
      .eq('route_id', route.id)
      .order('stop_order', { ascending: true, nullsFirst: false });

    const stops = [];
    for (const it of items || []) {
      const g = await itemGeoAndStatus(it);
      const gb = await stopGuidesWithBultos(it);
      stops.push({
        ...it,
        lat: g.lat,
        lng: g.lng,
        order_status: g.order_status,
        tracking_code: g.tracking_code,
        address: g.address,
        recipient: g.recipient,
        stop_status: g.terminal ? 'completada' : 'pendiente',
        guides: gb.guides,
        bultos_total: gb.bultos_total,
      });
    }

    return res.json({
      route: { ...route, placa: undefined },
      stops,
      stops_total: stops.length,
      stops_closed: stops.filter((s) => s.stop_status === 'completada').length,
    });
  } catch (err) {
    console.error('getRoute error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /v1/routes/:id/items — agrega una parada (route_item) por guía.
// body { guide_code }
// ─────────────────────────────────────────────────────────────
export const addRouteItem = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });

    const route = await getOwnedRoute(req.params.id, clienteId);
    if (!route) return res.status(404).json({ error: 'Ruta no encontrada' });

    const guideCode = String(req.body.guide_code || '').trim();
    if (!guideCode) return res.status(400).json({ error: 'guide_code es requerido' });

    const resolved = await resolveOrder(guideCode);
    if (!resolved) return res.status(404).json({ error: 'Guía no encontrada' });

    // Ownership: la orden debe ser del mismo cliente que la ruta.
    const orderCliente = await clienteOfUser(resolved.client_id);
    if (orderCliente && orderCliente !== clienteId) {
      return res.status(403).json({ error: 'OWNERSHIP_MISMATCH' });
    }

    const insert = {
      route_id: route.id,
      item_type: resolved.item_type,
      order_id: resolved.order_id,
      transport_order_id: resolved.transport_order_id,
      added_by: req.user.id,
    };

    const { data, error } = await supabaseAdmin
      .from('route_items').insert(insert).select().single();
    if (error) throw error;

    return res.status(201).json({ item: data, geocoded: resolved.lat != null && resolved.lng != null });
  } catch (err) {
    console.error('addRouteItem error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /v1/routes/:id/items/:itemId — quitar parada.
// ─────────────────────────────────────────────────────────────
export const removeRouteItem = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });

    const route = await getOwnedRoute(req.params.id, clienteId);
    if (!route) return res.status(404).json({ error: 'Ruta no encontrada' });

    const { data, error } = await supabaseAdmin
      .from('route_items')
      .delete()
      .eq('id', req.params.itemId)
      .eq('route_id', route.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Parada no encontrada' });
    return res.json({ removed: data });
  } catch (err) {
    console.error('removeRouteItem error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /v1/routes/:id/optimize — ordena las paradas por cercanía
// (nearest-neighbor, Haversine). Persiste stop_order + distance_km.
// body { start_lat?, start_lng? }  (si no se da, arranca en la 1ª parada geocodificada)
//
// Encapsulado para poder cambiar a VRP real después sin tocar el resto.
// ─────────────────────────────────────────────────────────────
function nearestNeighborOrder(points, start) {
  // points: [{ id, lat, lng }] con coords válidas. Devuelve [{id, stop_order, leg_km}]
  const remaining = [...points];
  const ordered = [];
  let cursor = start;
  let n = 1;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(cursor.lat, cursor.lng, remaining[i].lat, remaining[i].lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push({ id: next.id, stop_order: n, leg_km: Number(bestDist.toFixed(3)) });
    cursor = next;
    n++;
  }
  return ordered;
}

export const optimizeRoute = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });

    const route = await getOwnedRoute(req.params.id, clienteId);
    if (!route) return res.status(404).json({ error: 'Ruta no encontrada' });

    const { data: items } = await supabaseAdmin
      .from('route_items')
      .select('id, order_id, transport_order_id')
      .eq('route_id', route.id);

    // Resolver coordenadas de cada parada.
    const geocoded = [];
    const ungeocoded = [];
    for (const it of items || []) {
      const g = await itemGeoAndStatus(it);
      if (g.lat != null && g.lng != null) geocoded.push({ id: it.id, lat: g.lat, lng: g.lng });
      else ungeocoded.push(it.id);
    }

    if (geocoded.length === 0) {
      return res.status(422).json({ error: 'NO_GEOCODED_STOPS', message: 'Ninguna parada tiene coordenadas para optimizar' });
    }

    // Punto de partida: body o la primera parada geocodificada.
    let start;
    if (Number.isFinite(req.body.start_lat) && Number.isFinite(req.body.start_lng)) {
      start = { lat: req.body.start_lat, lng: req.body.start_lng };
    } else {
      start = { lat: geocoded[0].lat, lng: geocoded[0].lng };
    }

    const ordered = nearestNeighborOrder(geocoded, start);

    // Persistir stop_order + distance_km (por tramo) de las geocodificadas.
    for (const o of ordered) {
      await supabaseAdmin
        .from('route_items')
        .update({ stop_order: o.stop_order, distance_km: o.leg_km })
        .eq('id', o.id);
    }
    // Las sin coordenadas van al final, sin distancia.
    let tail = ordered.length;
    for (const id of ungeocoded) {
      tail++;
      await supabaseAdmin
        .from('route_items')
        .update({ stop_order: tail, distance_km: null })
        .eq('id', id);
    }

    const total_km = Number(ordered.reduce((s, o) => s + o.leg_km, 0).toFixed(3));
    return res.json({
      optimized: ordered.length,
      unGeocoded: ungeocoded.length,
      total_km,
      order: ordered,
    });
  } catch (err) {
    console.error('optimizeRoute error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /v1/routes/:id/status — transición de estado de la ruta.
// body { status }  (CREADA → EN_RUTA → COMPLETADA | CANCELADA)
// ─────────────────────────────────────────────────────────────
export const updateRouteStatus = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });

    const route = await getOwnedRoute(req.params.id, clienteId);
    if (!route) return res.status(404).json({ error: 'Ruta no encontrada' });

    const next = req.body.status;
    if (!VALID_STATUSES.includes(next)) {
      return res.status(400).json({ error: 'status inválido', valid: VALID_STATUSES });
    }
    const allowed = NEXT_STATUS[route.status] || [];
    if (route.status !== next && !allowed.includes(next)) {
      return res.status(409).json({ error: 'TRANSICION_INVALIDA', from: route.status, to: next, allowed });
    }

    const update = { status: next };
    if (next === ROUTE_STATUS.ACTIVE && !route.started_at) update.started_at = new Date().toISOString();
    if (next === ROUTE_STATUS.DONE) update.completed_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('routes').update(update).eq('id', route.id).select().single();
    if (error) throw error;

    return res.json({ route: data });
  } catch (err) {
    console.error('updateRouteStatus error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// PATCH /routes/:id/driver — Asignar (o desasignar) repartidor de la flota del
// cliente a una ruta. body { driver_id }  (driver_id null para desasignar).
export const assignRouteDriver = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no esta asociado a un cliente' });
    }

    const route = await getOwnedRoute(req.params.id, clienteId);
    if (!route) {
      return res.status(404).json({ error: 'Ruta no encontrada' });
    }

    const driverId = req.body.driver_id ?? null;

    // Desasignar
    if (driverId === null) {
      const { data, error } = await supabaseAdmin
        .from('routes')
        .update({ driver_id: null })
        .eq('id', route.id)
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ route: data });
    }

    // El repartidor debe existir y pertenecer a la flota del cliente
    const { data: driver, error: driverError } = await supabaseAdmin
      .from('drivers')
      .select('id, cliente_id, status, active')
      .eq('id', driverId)
      .maybeSingle();
    if (driverError) throw driverError;
    if (!driver) {
      return res.status(404).json({ error: 'Repartidor no encontrado' });
    }
    if (driver.cliente_id !== clienteId) {
      return res.status(403).json({ error: 'El repartidor no pertenece a tu flota' });
    }
    if (driver.active === false) {
      return res.status(409).json({ error: 'REPARTIDOR_INACTIVO' });
    }

    // Guard: un repartidor no puede tener mas de una ruta activa (CREADA/EN_RUTA)
    const { data: activeRoutes, error: activeError } = await supabaseAdmin
      .from('routes')
      .select('id')
      .eq('driver_id', driverId)
      .in('status', ['CREADA', 'EN_RUTA'])
      .neq('id', route.id);
    if (activeError) throw activeError;
    if (activeRoutes && activeRoutes.length > 0) {
      return res.status(409).json({ error: 'REPARTIDOR_CON_RUTA_ACTIVA', route_id: activeRoutes[0].id });
    }

    const { data: updatedRoute, error: updateError } = await supabaseAdmin
      .from('routes')
      .update({ driver_id: driverId })
      .eq('id', route.id)
      .select()
      .single();
    if (updateError) throw updateError;
    return res.status(200).json({ route: updatedRoute });
  } catch (err) {
    console.error('assignRouteDriver error:', err);
    return res.status(500).json({ error: err.message });
  }
};
