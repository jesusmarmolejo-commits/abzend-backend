import { supabaseAdmin } from '../services/supabase.js';

// ─────────────────────────────────────────────────────────────
// Helper: resolver el clientes.id (entidad de negocio) del usuario.
// req.user viene del middleware authenticate (id, email, full_name, role)
// y NO incluye cliente_id, por eso se consulta aquí.
// ─────────────────────────────────────────────────────────────
async function resolveClienteId(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('cliente_id')
    .eq('id', userId)
    .single();
  if (error || !data) return null;
  return data.cliente_id;
}

const normalizePlaca = (p) => String(p || '').toUpperCase().replace(/\s+/g, '').trim();

// ─────────────────────────────────────────────────────────────
// POST /v1/vehicles — el cliente autenticado da de alta una placa.
// El trigger de DB (enforce_vehicle_limit) rechaza si excede el tope;
// se mapea a 409 VEHICLE_LIMIT_REACHED.
// ─────────────────────────────────────────────────────────────
export const createVehicle = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });
    }

    const placa = normalizePlaca(req.body.placa);
    if (!placa) {
      return res.status(400).json({ error: 'placa es requerida' });
    }

    const { data, error } = await supabaseAdmin
      .from('vehicles')
      .insert({ client_id: clienteId, placa })
      .select()
      .single();

    if (error) {
      const msg = error.message || '';
      if (msg.includes('VEHICLE_LIMIT_REACHED')) {
        return res.status(409).json({ error: 'VEHICLE_LIMIT_REACHED' });
      }
      if (msg.includes('CLIENT_NOT_FOUND')) {
        return res.status(404).json({ error: 'Cliente no encontrado' });
      }
      // Índice único parcial: placa activa duplicada para el mismo cliente
      if (error.code === '23505' || /duplicate key|vehicles_client_placa_active/.test(msg)) {
        return res.status(409).json({ error: 'PLACA_ALREADY_ACTIVE' });
      }
      throw error;
    }

    return res.status(201).json({ vehicle: data });
  } catch (err) {
    console.error('createVehicle error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /v1/vehicles — placas activas del cliente + contador y tope.
// ─────────────────────────────────────────────────────────────
export const getMyVehicles = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });
    }

    const [{ data: vehicles, error: vErr }, { data: cliente, error: cErr }] = await Promise.all([
      supabaseAdmin
        .from('vehicles')
        .select('id, placa, status, created_at')
        .eq('client_id', clienteId)
        .eq('status', 'active')
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('clientes')
        .select('vehicle_limit, subscription_status, billing_model')
        .eq('id', clienteId)
        .single(),
    ]);

    if (vErr) throw vErr;
    if (cErr) throw cErr;

    return res.json({
      vehicles: vehicles || [],
      active_count: (vehicles || []).length,
      vehicle_limit: cliente.vehicle_limit,
      subscription_status: cliente.subscription_status,
      billing_model: cliente.billing_model,
    });
  } catch (err) {
    console.error('getMyVehicles error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /v1/vehicles/:id — el cliente desactiva una de sus placas
// (baja lógica; libera cupo del tope). Solo sobre placas propias.
// ─────────────────────────────────────────────────────────────
export const deactivateVehicle = async (req, res) => {
  try {
    const clienteId = await resolveClienteId(req.user.id);
    if (!clienteId) {
      return res.status(400).json({ error: 'El usuario no está asociado a un cliente' });
    }

    const { data, error } = await supabaseAdmin
      .from('vehicles')
      .update({ status: 'inactive', deactivated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('client_id', clienteId)
      .eq('status', 'active')
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Vehículo no encontrado' });
    }
    return res.json({ vehicle: data });
  } catch (err) {
    console.error('deactivateVehicle error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /v1/clients/:clientId/subscription — vista de suscripción para
// staff (admin / gerente_comercial). Devuelve estado, tope, vehículos
// activos y el historial de cambios de tope. El panel-admin lo consume
// vía backend (service_role) porque el RLS de vehicles impide que el
// admin lea con anon key vehículos de otro cliente.
// ─────────────────────────────────────────────────────────────
export const getClientSubscription = async (req, res) => {
  try {
    const clientId = req.params.clientId;

    const [
      { data: cliente, error: cErr },
      { data: vehicles, error: vErr },
      { data: history, error: hErr },
    ] = await Promise.all([
      supabaseAdmin
        .from('clientes')
        .select('id, razon_social, billing_model, subscription_status, vehicle_limit')
        .eq('id', clientId)
        .single(),
      supabaseAdmin
        .from('vehicles')
        .select('id, placa, status, created_at, deactivated_at')
        .eq('client_id', clientId)
        .eq('status', 'active')
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('vehicle_limit_changes')
        .select('id, old_limit, new_limit, source, reason, changed_by, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false }),
    ]);

    if (cErr || !cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (vErr) throw vErr;
    if (hErr) throw hErr;

    return res.json({
      client: cliente,
      active_count: (vehicles || []).length,
      vehicles: vehicles || [],
      limit_history: history || [],
    });
  } catch (err) {
    console.error('getClientSubscription error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /v1/clients/:clientId/vehicle-limit — override manual del tope.
// Solo admin / gerente_comercial (guard en la ruta). Escribe con
// service_role y audita el cambio con source='manual' (reason obligatorio).
// ─────────────────────────────────────────────────────────────
export const patchVehicleLimit = async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const newLimit = Number.parseInt(req.body.new_limit, 10);
    const reason = String(req.body.reason || '').trim();

    if (!Number.isInteger(newLimit) || newLimit < 0) {
      return res.status(400).json({ error: 'new_limit debe ser un entero >= 0' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'reason es obligatorio para un cambio manual' });
    }

    const { data: cliente, error: cErr } = await supabaseAdmin
      .from('clientes')
      .select('id, vehicle_limit')
      .eq('id', clientId)
      .single();
    if (cErr || !cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const oldLimit = cliente.vehicle_limit;

    const { error: updErr } = await supabaseAdmin
      .from('clientes')
      .update({ vehicle_limit: newLimit })
      .eq('id', clientId);
    if (updErr) throw updErr;

    const { data: change, error: chErr } = await supabaseAdmin
      .from('vehicle_limit_changes')
      .insert({
        client_id: clientId,
        old_limit: oldLimit,
        new_limit: newLimit,
        changed_by: req.user.id,
        source: 'manual',
        reason,
      })
      .select()
      .single();
    if (chErr) throw chErr;

    return res.json({ vehicle_limit: newLimit, change });
  } catch (err) {
    console.error('patchVehicleLimit error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /v1/webhooks/subscription — el proveedor de pago confirma el plan.
// Actualiza vehicle_limit y audita con source='webhook' (reason null).
// Auth: secreto compartido en header, NO JWT (los webhooks no traen sesión).
// Configurar SUBSCRIPTION_WEBHOOK_SECRET en el entorno (Render).
// ─────────────────────────────────────────────────────────────
export const subscriptionWebhook = async (req, res) => {
  try {
    const secret = process.env.SUBSCRIPTION_WEBHOOK_SECRET;
    const provided = req.headers['x-webhook-secret'];
    if (!secret || provided !== secret) {
      return res.status(401).json({ error: 'Firma de webhook inválida' });
    }

    const clientId = req.body.client_id;
    const newLimit = Number.parseInt(req.body.vehicle_limit, 10);
    const subscriptionStatus = req.body.subscription_status; // opcional

    if (!clientId || !Number.isInteger(newLimit) || newLimit < 0) {
      return res.status(400).json({ error: 'client_id y vehicle_limit (entero >= 0) son requeridos' });
    }

    const { data: cliente, error: cErr } = await supabaseAdmin
      .from('clientes')
      .select('id, vehicle_limit')
      .eq('id', clientId)
      .single();
    if (cErr || !cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const oldLimit = cliente.vehicle_limit;

    const update = { vehicle_limit: newLimit };
    if (['active', 'past_due', 'suspended'].includes(subscriptionStatus)) {
      update.subscription_status = subscriptionStatus;
    }

    const { error: updErr } = await supabaseAdmin
      .from('clientes')
      .update(update)
      .eq('id', clientId);
    if (updErr) throw updErr;

    if (oldLimit !== newLimit) {
      const { error: chErr } = await supabaseAdmin
        .from('vehicle_limit_changes')
        .insert({
          client_id: clientId,
          old_limit: oldLimit,
          new_limit: newLimit,
          changed_by: null,
          source: 'webhook',
          reason: null,
        });
      if (chErr) throw chErr;
    }

    return res.json({ ok: true, vehicle_limit: newLimit });
  } catch (err) {
    console.error('subscriptionWebhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
