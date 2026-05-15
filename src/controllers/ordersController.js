import { supabaseAdmin } from '../services/supabase.js';

// Calcular distancia entre dos coordenadas (fórmula Haversine)
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radio de la Tierra en km
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
    console.error('getOrders error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// GET /orders/:id
export const getOrder = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select(`*, client:users!client_id(*), driver:drivers!driver_id(*, user:users(*)), events:order_events(*)`)
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Orden no encontrada' });

    // Clientes solo pueden ver sus propias órdenes
    if (req.user.role === 'client' && data.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    res.json({ order: data });
  } catch (err) {
    console.error('getOrder error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// GET /orders/qr/:code — Repartidor escanea QR (solo driver o admin)
export const getOrderByQR = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('*, client:users!client_id(full_name, phone)')
      .eq('qr_code', req.params.code)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Código QR no válido o paquete no encontrado' });
    res.json({ order: data });
  } catch (err) {
    console.error('getOrderByQR error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// POST /orders — Cliente crea una nueva orden
export const createOrder = async (req, res) => {
  const {
    sender_name, sender_phone, origin_address, origin_lat, origin_lng,
    recipient_name, recipient_phone, dest_address, dest_lat, dest_lng,
    package_type, weight_kg, service, instructions, has_insurance
  } = req.body;

  try {
    // Calcular precio
    const prices = { standard: 95, express: 180, same_day: 280 };
    const subtotal = prices[service] || 95;
    const insurance_cost = has_insurance ? 25 : 0;
    const tax = Math.round((subtotal + insurance_cost) * 0.16 * 100) / 100;
    const total = subtotal + insurance_cost + tax;

    const tracking_code = `ABZ-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.random().toString(36).substr(2,8).toUpperCase()}`

    const { data, error } = await supabaseAdmin
      .from('orders')
      .insert({
        tracking_code,
        client_id: req.user.id,
        sender_name, sender_phone, origin_address, origin_lat, origin_lng,
        recipient_name, recipient_phone, dest_address, dest_lat, dest_lng,
        package_type, weight_kg, service, instructions, has_insurance,
        subtotal, insurance_cost, tax, total
      })
      .select()
      .single();

    if (error) throw error;

    // Registrar evento inicial
    await supabaseAdmin.from('order_events').insert({
      order_id: data.id, status: 'pending',
      note: 'Orden creada por cliente', created_by: req.user.id
    });

    res.status(201).json({ order: data });
  } catch (err) {
    console.error('createOrder error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// PATCH /orders/:id/status — Actualizar estado (repartidor o admin)
export const updateStatus = async (req, res) => {
  const { status, notes, lat, lng } = req.body;
  const VALID = ['pending','assigned','picked_up','in_transit','delivered','failed','cancelled'];
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

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status, status_updated_at: new Date().toISOString(), ...extra })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Agregar evento al timeline
    await supabaseAdmin.from('order_events').insert({
      order_id: req.params.id, status, note: notes, lat, lng,
      created_by: req.user.id
    });

    // NOTIFICACIÓN "PRÓXIMO EN RUTA" — Si está en tránsito y a <2km del destino
    if (status === 'in_transit' && lat && lng && orderData?.dest_lat && orderData?.dest_lng) {
      const distance = getDistanceKm(lat, lng, orderData.dest_lat, orderData.dest_lng);
      
      if (distance < 2) { // Menos de 2km = próximo a llegar
        const driverName = orderData.driver?.user?.full_name || 'Tu repartidor';
        await notifyNearDelivery(orderData, driverName);
        
        // Registrar evento de notificación
        await supabaseAdmin.from('order_events').insert({
          order_id: req.params.id,
          status: 'in_transit',
          status_code: 'NRD', // Near Delivery
          note: `Cliente notificado: repartidor a ${distance.toFixed(1)}km del destino`,
          lat, lng,
          created_by: req.user.id
        });
      }
    }

    res.json({ order: data });
  } catch (err) {
    console.error('updateStatus error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
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
    console.error('confirmPickup error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
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

    // Actualizar estado del driver a busy
    await supabaseAdmin.from('drivers').update({ status: 'busy' }).eq('id', driver_id);

    res.json({ order: data });
  } catch (err) {
    console.error('assignDriver error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
