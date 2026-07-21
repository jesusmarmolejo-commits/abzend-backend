import { supabaseAdmin } from '../services/supabase.js';

// ─────────────────────────────────────────────────────────────
// requireActiveSubscription
// Bloquea la creación de ruta / parada / guía cuando el cliente está en
// modelo de suscripción y su estado NO es 'active'. Para clientes en
// modelo 'contract' no aplica (pasa de largo).
//
// Resuelve el cliente desde req.user (users.cliente_id → clientes). El
// staff (admin, ops, etc.) no tiene cliente_id asociado y NO es frenado
// por este middleware: la restricción es sobre la cuenta del cliente
// dueño de la operación self-serve.
// ─────────────────────────────────────────────────────────────
export const requireActiveSubscription = async (req, res, next) => {
  try {
    const { data: user, error: uErr } = await supabaseAdmin
      .from('users')
      .select('cliente_id')
      .eq('id', req.user.id)
      .single();

    // Sin cliente asociado (staff u operador): no aplica el gate.
    if (uErr || !user?.cliente_id) return next();

    const { data: cliente, error: cErr } = await supabaseAdmin
      .from('clientes')
      .select('billing_model, subscription_status')
      .eq('id', user.cliente_id)
      .single();

    if (cErr || !cliente) return next();

    // Solo aplica al modelo de suscripción.
    if (cliente.billing_model !== 'subscription') return next();

    if (cliente.subscription_status !== 'active') {
      return res.status(402).json({
        error: 'SUBSCRIPTION_INACTIVE',
        subscription_status: cliente.subscription_status,
        message: 'Tu suscripción no está activa. Contacta a tu ejecutivo ABZEND.',
      });
    }

    return next();
  } catch (err) {
    console.error('requireActiveSubscription error:', err);
    return res.status(500).json({ error: err.message });
  }
};
