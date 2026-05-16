import { supabaseAdmin } from '../services/supabase.js';

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
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select(`*, client:users!client_id(*), driver:drivers!driver_id(*, user:users(*)), events:order_events(*)`)
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Orden no encontrada' });
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

    const { data, error } = await supabaseAdmin
      .from('orders')
      .insert({
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
    res.status(500).json({ error: err.message });
  }
};

// PATCH /orders/:id/status — Actualizar estado (repartidor o admin)
export const updateStatus = async (req, res) => {
  const { status, notes, lat, lng } = req.body;
  const VALID = ['pending','assigned','picked_up','in_transit','delivered','failed','cancelled'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Estado no válido' });

  try {
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

    res.json({ order: data });
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

    // Actualizar estado del driver a busy
    await supabaseAdmin.from('drivers').update({ status: 'busy' }).eq('id', driver_id);

    res.json({ order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
