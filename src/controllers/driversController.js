import { supabaseAdmin } from '../services/supabase.js';

// cliente (clientes.id) dueño de un usuario dado (users.id)
async function resolveClienteId(userId) {
  const { data } = await supabaseAdmin
    .from('users').select('cliente_id').eq('id', userId).single();
  return data?.cliente_id ?? null;
}

// GET /driver/orders — Órdenes asignadas al repartidor autenticado
export const getMyOrders = async (req, res) => {
  try {
    // Obtener el driver_id del usuario
    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id').eq('user_id', req.user.id).single();

    if (!driver) return res.status(404).json({ error: 'Perfil de repartidor no encontrado' });

    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('id, tracking_code, status, origin_address, dest_address, service, weight_kg, recipient_name, recipient_phone, instructions, created_at')
      .eq('driver_id', driver.id)
      .in('status', ['assigned', 'picked_up', 'in_transit'])
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Formatear para la app móvil
    const orders = data.map(o => ({
      id: o.tracking_code,
      dbId: o.id,
      status: o.status,
      origin: o.origin_address,
      destination: o.dest_address,
      service: o.service,
      weight: `${o.weight_kg} kg`,
      client: o.recipient_name,
      phone: o.recipient_phone,
      instructions: o.instructions,
      priority: o.service === 'same_day'
    }));

    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /driver/history — Historial de entregas
export const getHistory = async (req, res) => {
  const { period = 'today' } = req.query;
  const now = new Date();
  let from = new Date();

  if (period === 'today') from.setHours(0, 0, 0, 0);
  else if (period === 'week') from.setDate(now.getDate() - 7);
  else if (period === 'month') from.setMonth(now.getMonth() - 1);

  try {
    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id').eq('user_id', req.user.id).single();

    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('tracking_code, dest_address, delivered_at, total')
      .eq('driver_id', driver.id)
      .eq('status', 'delivered')
      .gte('delivered_at', from.toISOString())
      .order('delivered_at', { ascending: false });

    if (error) throw error;

    const orders = data.map(o => ({
      id: o.tracking_code,
      destination: o.dest_address,
      time: new Date(o.delivered_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
      total: o.total
    }));

    res.json({ orders, count: orders.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PATCH /driver/status — Cambiar estado online/offline
export const updateDriverStatus = async (req, res) => {
  const { status } = req.body;
  if (!['online', 'offline', 'busy'].includes(status))
    return res.status(400).json({ error: 'Estado no válido' });

  try {
    const { error } = await supabaseAdmin
      .from('drivers')
      .update({ status, last_seen_at: new Date() })
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ message: `Estado actualizado: ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /driver/location — Actualizar GPS en tiempo real
// La app móvil llama esto cada 15-30 segundos mientras está activa
export const updateLocation = async (req, res) => {
  const { latitude, longitude, order_id } = req.body;
  if (!latitude || !longitude) return res.status(400).json({ error: 'Coordenadas requeridas' });

  try {
    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id').eq('user_id', req.user.id).single();

    // Actualizar última posición en drivers
    await supabaseAdmin.from('drivers').update({
      last_lat: latitude, last_lng: longitude, last_seen_at: new Date()
    }).eq('id', driver.id);

    // Insertar en historial de ubicaciones (para rastreo del cliente)
    await supabaseAdmin.from('driver_locations').insert({
      driver_id: driver.id,
      order_id: order_id || null,
      lat: latitude,
      lng: longitude
    });

    // Supabase Realtime notifica automáticamente a los suscriptores
    res.json({ message: 'Ubicación actualizada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /admin/drivers — Todos los repartidores (admin)
export const getAllDrivers = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('drivers')
      .select('*, user:users(full_name, email, phone)')
      .order('status');

    if (error) throw error;
    res.json({ drivers: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /client/drivers — Repartidores de la flota del cliente autenticado
export const listClientDrivers = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no esta asociado a un cliente' });
    }

    const { data: drivers, error } = await supabaseAdmin
      .from('drivers')
      .select('id, status, license_plate, vehicle_type, user:user_id(full_name, email, phone)')
      .eq('cliente_id', clienteId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const mapped = (drivers || []).map((d) => ({
      id: d.id,
      name: d.user?.full_name || null,
      email: d.user?.email || null,
      phone: d.user?.phone || null,
      status: d.status,
      license_plate: d.license_plate,
    }));

    return res.status(200).json({ drivers: mapped });
  } catch (err) {
    console.error('listClientDrivers error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// POST /client/drivers/link — Liga un repartidor EXISTENTE (por email) a la
// flota del cliente. No crea cuentas. body { email }.
export const linkClientDriver = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no esta asociado a un cliente' });
    }

    const email = String(req.body.email || '').trim();
    if (!email) {
      return res.status(400).json({ error: 'email requerido' });
    }

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, role, full_name, email')
      .ilike('email', email)
      .maybeSingle();
    if (userError) throw userError;
    if (!user || user.role !== 'driver') {
      return res.status(404).json({ error: 'No existe un repartidor con ese correo' });
    }

    const { data: driver, error: driverError } = await supabaseAdmin
      .from('drivers')
      .select('id, cliente_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (driverError) throw driverError;
    if (!driver) {
      return res.status(404).json({ error: 'Ese usuario no tiene perfil de repartidor' });
    }

    if (driver.cliente_id && driver.cliente_id !== clienteId) {
      return res.status(409).json({ error: 'El repartidor ya pertenece a otra flota' });
    }
    if (driver.cliente_id === clienteId) {
      return res.status(200).json({ driver: { id: driver.id, name: user.full_name, email: user.email }, already: true });
    }

    const { error: updateError } = await supabaseAdmin
      .from('drivers')
      .update({ cliente_id: clienteId })
      .eq('id', driver.id);
    if (updateError) throw updateError;

    return res.status(200).json({ driver: { id: driver.id, name: user.full_name, email: user.email } });
  } catch (err) {
    console.error('linkClientDriver error:', err);
    return res.status(500).json({ error: err.message });
  }
};
