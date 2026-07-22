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
      .select('id, status, active, operator_code, license_plate, vehicle_type, user:user_id(full_name, email, phone)')
      .eq('cliente_id', clienteId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const mapped = (drivers || []).map((d) => ({
      id: d.id,
      name: d.user?.full_name || null,
      email: d.user?.email || null,
      phone: d.user?.phone || null,
      status: d.status,
      active: d.active,
      operator_code: d.operator_code,
      license_plate: d.license_plate,
    }));

    return res.status(200).json({ drivers: mapped });
  } catch (err) {
    console.error('listClientDrivers error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// POST /client/drivers — Crea un repartidor NUEVO (cuenta auth + users + drivers)
// ligado a la flota del cliente. body { email, password, full_name, phone,
// license_plate?, vehicle_type? }. Rollback best-effort si algo falla.
export const createClientDriver = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no esta asociado a un cliente' });
    }

    const { email, password, full_name, phone, license_plate, vehicle_type } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'email, password y full_name son requeridos' });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({
        auth_id: authData.user.id,
        email,
        full_name,
        phone: phone || null,
        role: 'driver',
        cliente_id: clienteId,
      })
      .select()
      .single();
    if (userError) {
      try { await supabaseAdmin.auth.admin.deleteUser(authData.user.id); } catch (_) {}
      return res.status(400).json({ error: userError.message });
    }

    const driverInsert = {
      user_id: user.id,
      cliente_id: clienteId,
      license_plate: license_plate || null,
    };
    if (vehicle_type) driverInsert.vehicle_type = vehicle_type;

    const { data: driver, error: driverError } = await supabaseAdmin
      .from('drivers')
      .insert(driverInsert)
      .select('id, operator_code, active')
      .single();
    if (driverError) {
      try { await supabaseAdmin.from('users').delete().eq('id', user.id); } catch (_) {}
      try { await supabaseAdmin.auth.admin.deleteUser(authData.user.id); } catch (_) {}
      return res.status(400).json({ error: driverError.message });
    }

    return res.status(201).json({
      driver: { id: driver.id, name: full_name, email, operator_code: driver.operator_code, active: driver.active },
    });
  } catch (err) {
    console.error('createClientDriver error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// PATCH /client/drivers/:id — Habilitar/deshabilitar un repartidor de la flota.
// Deshabilitar banea la cuenta auth (no puede iniciar sesion). body { active }.
export const setClientDriverActive = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no esta asociado a un cliente' });
    }

    const { data: driver, error: driverError } = await supabaseAdmin
      .from('drivers')
      .select('id, cliente_id, user_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!driver || driverError) {
      return res.status(404).json({ error: 'Repartidor no encontrado' });
    }
    if (driver.cliente_id !== clienteId) {
      return res.status(403).json({ error: 'El repartidor no pertenece a tu flota' });
    }

    const active = req.body.active === true || req.body.active === 'true';

    await supabaseAdmin.from('drivers').update({ active }).eq('id', driver.id);

    const { data: userData } = await supabaseAdmin
      .from('users').select('auth_id').eq('id', driver.user_id).maybeSingle();

    if (userData?.auth_id) {
      try {
        await supabaseAdmin.auth.admin.updateUserById(userData.auth_id, {
          ban_duration: active ? 'none' : '876000h',
        });
      } catch (banError) {
        console.warn('Ban/unban failed:', banError);
      }
    }

    return res.status(200).json({ driver: { id: driver.id, active } });
  } catch (err) {
    console.error('setClientDriverActive error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// PATCH /client/drivers/:id/password — Cambiar la contrasena de un repartidor
// de la flota. body { password }.
export const setClientDriverPassword = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no esta asociado a un cliente' });
    }

    const { data: driver, error: driverError } = await supabaseAdmin
      .from('drivers')
      .select('id, cliente_id, user_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!driver || driverError) {
      return res.status(404).json({ error: 'Repartidor no encontrado' });
    }
    if (driver.cliente_id !== clienteId) {
      return res.status(403).json({ error: 'El repartidor no pertenece a tu flota' });
    }

    const password = String(req.body.password || '');
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres' });
    }

    const { data: userData } = await supabaseAdmin
      .from('users').select('auth_id').eq('id', driver.user_id).maybeSingle();
    if (!userData?.auth_id) {
      return res.status(404).json({ error: 'Cuenta del repartidor no encontrada' });
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userData.auth_id, { password });
    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('setClientDriverPassword error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─── ADMIN (ABZEND global, cualquier repartidor, sin scoping de cliente) ─────

// PATCH /admin/drivers/:id — habilitar/deshabilitar (+ ban/unban auth). body { active }.
export const setAdminDriverActive = async (req, res) => {
  try {
    const { data: driver, error: driverError } = await supabaseAdmin
      .from('drivers')
      .select('id, user_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!driver || driverError) {
      return res.status(404).json({ error: 'Repartidor no encontrado' });
    }

    const active = req.body.active === true || req.body.active === 'true';

    const { error: updateError } = await supabaseAdmin
      .from('drivers').update({ active }).eq('id', driver.id);
    if (updateError) throw updateError;

    const { data: user } = await supabaseAdmin
      .from('users').select('auth_id').eq('id', driver.user_id).maybeSingle();
    if (user?.auth_id) {
      try {
        await supabaseAdmin.auth.admin.updateUserById(user.auth_id, {
          ban_duration: active ? 'none' : '876000h',
        });
      } catch (e) {
        console.warn('Ban/unban failed:', e);
      }
    }

    return res.status(200).json({ driver: { id: driver.id, active } });
  } catch (err) {
    console.error('setAdminDriverActive error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// PATCH /admin/drivers/:id/password — cambiar contrasena. body { password }.
export const setAdminDriverPassword = async (req, res) => {
  try {
    const { data: driver, error: driverError } = await supabaseAdmin
      .from('drivers')
      .select('id, user_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!driver || driverError) {
      return res.status(404).json({ error: 'Repartidor no encontrado' });
    }

    const password = String(req.body.password || '');
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres' });
    }

    const { data: user } = await supabaseAdmin
      .from('users').select('auth_id').eq('id', driver.user_id).maybeSingle();
    if (!user?.auth_id) {
      return res.status(404).json({ error: 'Cuenta del repartidor no encontrada' });
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.auth_id, { password });
    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('setAdminDriverPassword error:', err);
    return res.status(500).json({ error: err.message });
  }
};
