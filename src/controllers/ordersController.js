import { supabaseAdmin } from '../services/supabase.js';

// Geocodificar una dirección usando Nominatim (OpenStreetMap)
async function geocodeAddress(addressString) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(addressString)}&countrycodes=mx`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ABZEND/1.0 logistics@abzend.mx' }
    });
    if (!res.ok) return { lat: null, lng: null };
    const results = await res.json();
    if (!results.length) return { lat: null, lng: null };
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch {
    return { lat: null, lng: null };
  }
}

// Calcular distancia entre dos coordenadas (fórmula Haversine)
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Enviar notificación "próximo en ruta" via Supabase Edge Function
async function notifyNearDelivery(order, driverName) {
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/notify-near-delivery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        recipient_email: order.client.email,
        recipient_name: order.client.full_name,
        tracking_code: order.tracking_code,
        driver_name: driverName,
        estimated_minutes: 10
      })
    });
    if (!response.ok) console.error('Error enviando notificación:', await response.text());
  } catch (err) {
    console.error('Error al notificar proximidad:', err.message);
  }
}

// GET /orders — Admin: todas | Cliente: las suyas
export const getOrders = async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('orders')
      .select(`*, client:users!client_id(full_name, email, phone), driver:drivers!driver_id(id, user:users(full_name, phone))`)
      .order('created_at', { ascending: false });

    if (req.user.role === 'client') query = query.eq('client_id', req.user.id);
    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ orders: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /orders/:id
export const getOrder = async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('orders')
      .select(`*, client:users!client_id(*), driver:drivers!driver_id(*, user:users(*)), events:order_events(*)`)
      .eq('id', req.params.id);

    // 🔒 SECURITY: Clients can only read their own orders (IDOR fix)
    if (req.user.role === 'client') {
      query = query.eq('client_id', req.user.id);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    res.json({ order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /orders/qr/:code — Repartidor escanea QR
export const getOrderByQR = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('*, client:users!client_id(full_name, phone)')
      .eq('qr_code', req.params.code)
      .single();

    if (error) return res.status(404).json({ error: 'Código QR no válido o paquete no encontrado' });
    res.json({ order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /orders — Cliente crea una nueva orden
export const createOrder = async (req, res) => {
  try {
    const geocoords = {};

    if (req.body.dest_address) {
      const { lat, lng } = await geocodeAddress(req.body.dest_address);
      if (req.body.dest_lat == null) geocoords.dest_lat = lat;
      if (req.body.dest_lng == null) geocoords.dest_lng = lng;
    }

    if (req.body.origin_address) {
      const { lat, lng } = await geocodeAddress(req.body.origin_address);
      if (req.body.origin_lat == null) geocoords.origin_lat = lat;
      if (req.body.origin_lng == null) geocoords.origin_lng = lng;
    }

    const { data, error } = await supabaseAdmin
      .from('orders')
      .insert({ ...req.body, ...geocoords, client_id: req.user.id })
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin.from('order_events').insert({
      order_id: data.id, status: 'pending',
      note: 'Orden creada', created_by: req.user.id
    });

    res.status(201).json({ order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PATCH /orders/:id/status — Actualizar estado (repartidor o admin)
export const updateStatus = async (req, res) => {
  const { status, notes, lat, lng } = req.body;
  const VALID = ['pending','assigned','picked_up','in_transit','delivered','failed','cancelled','regreso_a_cliente'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Estado no válido' });

  try {
    // Obtener datos completos de la orden antes de actualizar
    const { data: orderData } = await supabaseAdmin
      .from('orders')
      .select('*, client:users!client_id(full_name, email), driver:drivers!driver_id(id, user:users(full_name))')
      .eq('id', req.params.id)
      .single();

    const extra = {};
    if (status === 'delivered') extra.delivered_at = new Date().toISOString();

    // Lógica de intentos fallidos: incrementar contador y auto-escalar a regreso_a_cliente
    let finalStatus = status;
    if (status === 'failed') {
      const currentIntentos = (orderData?.intentos_entrega || 0) + 1;
      extra.intentos_entrega = currentIntentos;
      if (currentIntentos >= 3) {
        finalStatus = 'regreso_a_cliente';
        extra.regreso_iniciado_at = new Date().toISOString();
      }
    }

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status: finalStatus, status_updated_at: new Date().toISOString(), ...extra })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Agregar evento al timeline
    await supabaseAdmin.from('order_events').insert({
      order_id: req.params.id, status: finalStatus, note: notes, lat, lng,
      created_by: req.user.id
    });

    // Auto-escalación — evento adicional si se alcanzó el límite de intentos
    if (status === 'failed' && finalStatus === 'regreso_a_cliente') {
      await supabaseAdmin.from('order_events').insert({
        order_id: req.params.id,
        status: 'regreso_a_cliente',
        status_code: 'RTO',
        note: '3 intentos fallidos — paquete en retorno al origen. Requiere override de supervisor.',
        created_by: req.user.id
      });
    }

    // NOTIFICACIÓN "PRÓXIMO EN RUTA" — Si está en tránsito y a <2km del destino
    if (status === 'in_transit' && lat && lng && orderData?.dest_lat && orderData?.dest_lng) {
      const distance = getDistanceKm(lat, lng, orderData.dest_lat, orderData.dest_lng);
      if (distance < 2) {
        const driverName = orderData.driver?.user?.full_name || 'Tu repartidor';
        await notifyNearDelivery(orderData, driverName);

        await supabaseAdmin.from('order_events').insert({
          order_id: req.params.id,
          status: 'in_transit',
          status_code: 'NRD',
          note: `Cliente notificado: repartidor a ${distance.toFixed(1)}km del destino`,
          lat, lng,
          created_by: req.user.id
        });
      }
    }

    res.json({ order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /orders/:id/override — Supervisor fuerza reintento de entrega
export const supervisorOverride = async (req, res) => {
  const { motivo } = req.body;
  if (!motivo || motivo.trim().length < 10) {
    return res.status(400).json({ error: 'Se requiere un motivo de al menos 10 caracteres.' });
  }

  try {
    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('orders')
      .select('id, status, tracking_code, intentos_entrega')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.status !== 'regreso_a_cliente') {
      return res.status(400).json({
        error: `La orden no está en estado regreso_a_cliente (estado actual: ${order.status})`
      });
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('orders')
      .update({
        status: 'pending',
        intentos_entrega: 0,
        regreso_iniciado_at: null,
        status_updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updErr) throw updErr;

    // Audit trail completo en order_events
    await supabaseAdmin.from('order_events').insert({
      order_id: req.params.id,
      status: 'pending',
      status_code: 'LSR',
      note: `[OVERRIDE SUPERVISOR] ${motivo.trim()} — Intentos reiniciados. Actor: ${req.user.email} (${req.user.role})`,
      created_by: req.user.id
    });

    res.json({ order: updated, message: 'Override aplicado. Orden devuelta a Pendiente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /orders/:id/pickup — Confirmar recolección (escaneo QR)
export const confirmPickup = async (req, res) => {
  try {
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('id, status, driver_id')
      .eq('id', req.params.id)
      .single();

    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.status !== 'assigned') return res.status(400).json({ error: 'La orden no está lista para recoger' });

    await supabaseAdmin.from('orders').update({ status: 'picked_up', status_updated_at: new Date() }).eq('id', order.id);
    await supabaseAdmin.from('order_events').insert({ order_id: order.id, status: 'picked_up', note: 'Paquete recogido — QR escaneado', created_by: req.user.id });

    res.json({ message: 'Recolección confirmada', orderId: order.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /admin/orders/:id/assign — Admin asigna repartidor
export const assignDriver = async (req, res) => {
  const { driver_id } = req.body;
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ driver_id, status: 'assigned', status_updated_at: new Date() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin.from('order_events').insert({
      order_id: req.params.id, status: 'assigned',
      note: `Asignado a repartidor`, created_by: req.user.id
    });

    await supabaseAdmin.from('drivers').update({ status: 'busy' }).eq('id', driver_id);

    res.json({ order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PATCH /orders/:id/reassign — Reasignar orden a nuevo repartidor
export const reassignOrder = async (req, res) => {
  try {
    const { driver_id, notas_reasignacion } = req.body;
    const orderId = req.params.id;

    if (!driver_id) {
      return res.status(400).json({
        success: false,
        error: 'driver_id es requerido'
      });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (orderError || !order) {
      return res.status(404).json({
        success: false,
        error: 'Orden no encontrada'
      });
    }

    if (order.status === 'delivered' || order.status === 'cancelled') {
      return res.status(403).json({
        success: false,
        error: `No se puede reasignar una orden con estado: ${order.status}`
      });
    }

    const { data: driverUser, error: driverUserError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', driver_id)
      .eq('role', 'driver')
      .single();

    const { data: driverRecord, error: driverRecordError } = await supabaseAdmin
      .from('drivers')
      .select('id')
      .eq('id', driver_id)
      .single();

    if ((driverUserError && driverRecordError) || (!driverUser && !driverRecord)) {
      return res.status(404).json({
        success: false,
        error: 'Repartidor no encontrado'
      });
    }

    const updateData = {
      status: 'pending',
      driver_id,
      status_updated_at: new Date().toISOString()
    };

    if (notas_reasignacion !== undefined) {
      updateData.notas_reasignacion = notas_reasignacion;
    }

    const { data: updatedOrder, error: updateError } = await supabaseAdmin
      .from('orders')
      .update(updateData)
      .eq('id', orderId)
      .select('id, status, driver_id')
      .single();

    if (updateError) {
      return res.status(500).json({
        success: false,
        error: 'Error al actualizar la orden'
      });
    }

    const { error: eventError } = await supabaseAdmin
      .from('order_events')
      .insert({
        order_id: orderId,
        type: 'reassignment',
        description: `Reasignado a nuevo repartidor por ${req.user.role}`,
        created_by: req.user.id
      });

    if (eventError) {
      return res.status(500).json({
        success: false,
        error: 'Error al registrar el evento de reasignación'
      });
    }

    return res.status(200).json({
      success: true,
      order: {
        id: updatedOrder.id,
        status: updatedOrder.status,
        driver_id: updatedOrder.driver_id
      }
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};
