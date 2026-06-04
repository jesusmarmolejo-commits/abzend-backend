import { supabaseAdmin } from '../services/supabase.js';
import express from 'express';
import { login, register } from '../controllers/authController.js';
import { getOrders, getOrder, getOrderByQR, createOrder, updateStatus, confirmPickup, assignDriver, supervisorOverride, reassignOrder } from '../controllers/ordersController.js';
import { getMyOrders, getHistory, updateDriverStatus, updateLocation, getAllDrivers } from '../controllers/driversController.js';
import { createPaymentIntent, stripeWebhook, getPaymentStatus } from '../controllers/paymentsController.js';
import { uploadPhoto, uploadSignature, uploadNote, confirmDeliveryWithProof, getEvidence, getEvidenceByType } from '../controllers/evidenceController.js';
import { authenticate, requireRole, sanitize, resetLoginAttempts, ROLE_GROUPS } from '../middleware/auth.js'
import { loginRateLimitRedis, getRateLimitStats } from '../middleware/rateLimitRedis.js'
import { apiKeyAuth } from '../middleware/apiKeyAuth.js'
import { createBatch, createApiKey, listApiKeys, revokeApiKey, createWebhook, testWebhook } from '../controllers/apiBatchController.js';

const router = express.Router();

// ─── Auth ───────────────────────────────────────────────────────────────────
router.post('/auth/login',    loginRateLimitRedis, sanitize, login);
router.post('/auth/register', authenticate, requireRole(...ROLE_GROUPS.admin_only), sanitize, register);

// ─── Órdenes (cliente) ──────────────────────────────────────────────────────
router.get ('/orders',          authenticate, getOrders);
router.get ('/orders/qr/:code', authenticate, getOrderByQR);
router.get ('/orders/:id',      authenticate, getOrder);
router.post('/orders',          authenticate, requireRole('client','admin','supervisor','gerente_comercial','gerente_operaciones'), sanitize, createOrder);

// ─── Órdenes (operaciones) ──────────────────────────────────────────────────
router.post ('/orders/:id/pickup', authenticate, requireRole('driver','admin','supervisor'), confirmPickup);
router.patch('/orders/:id/status', authenticate, requireRole('driver','admin','supervisor','station','gerente_operaciones'), updateStatus);
router.post ('/orders/:id/override', authenticate, requireRole('admin','supervisor'), sanitize, supervisorOverride);
router.patch('/orders/:id/reassign', authenticate, requireRole('admin','supervisor','gerente_operaciones','station'), sanitize, reassignOrder);

// ─── Evidencia de Entregas (Fotos, Firma, Notas) ───────────────────────────────
router.post ('/orders/:id/evidence/photo',         authenticate, requireRole('driver','admin','supervisor'), uploadPhoto);
router.post ('/orders/:id/evidence/signature',     authenticate, requireRole('driver','admin','supervisor'), uploadSignature);
router.post ('/orders/:id/evidence/note',          authenticate, requireRole('driver','admin','supervisor'), sanitize, uploadNote);
router.post ('/orders/:id/confirm-with-proof',     authenticate, requireRole('driver','admin','supervisor'), confirmDeliveryWithProof);
router.get  ('/orders/:id/evidence',               authenticate, getEvidence);
router.get  ('/orders/:id/evidence/:type',         authenticate, getEvidenceByType);

// ─── Admin ──────────────────────────────────────────────────────────────────
router.post('/admin/orders/:id/assign', authenticate, requireRole('admin','supervisor','station','gerente_operaciones'), assignDriver);
router.get ('/admin/drivers',           authenticate, requireRole(...ROLE_GROUPS.all_staff), getAllDrivers);
router.get ('/admin/rate-limit-stats',  authenticate, requireRole('admin'), getRateLimitStats);

// ─── Repartidor (móvil) ─────────────────────────────────────────────────────
router.get  ('/driver/orders',   authenticate, requireRole('driver'), getMyOrders);
router.get  ('/driver/history',  authenticate, requireRole('driver'), getHistory);
router.patch('/driver/status',   authenticate, requireRole('driver'), updateDriverStatus);
router.post ('/driver/location', authenticate, requireRole('driver'), updateLocation);

// ─── Pagos / Stripe ─────────────────────────────────────────────────────────
router.post('/payments/webhook',    express.raw({ type: 'application/json' }), stripeWebhook);
router.post('/payments/intent',     authenticate, createPaymentIntent);
router.get ('/payments/order/:id',  authenticate, getPaymentStatus);

// ─── Estación — RPCs anti-robo ──────────────────────────────────────────────
router.get('/station/pending-returns', authenticate, requireRole(...ROLE_GROUPS.ops), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('get_drivers_with_pending_returns');
    if (error) throw error;
    res.json({ data: data || [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/station/orders', authenticate, requireRole(...ROLE_GROUPS.ops), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('get_station_orders');
    if (error) throw error;
    res.json({ data: data || [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Crear usuario desde panel admin ────────────────────────────────────────
router.post('/admin/users', authenticate, requireRole('admin','supervisor','gerente_operaciones'), sanitize, async (req, res) => {
  const { email, password, full_name, phone, role = 'client', cliente_id } = req.body;
  const actorRole = req.user.role;

  // Supervisor y gerente_operaciones solo pueden crear driver/station
  const restrictedRoles = ['supervisor','gerente_operaciones'];
  const allowedCreation = ['driver','station','client'];
  if (restrictedRoles.includes(actorRole) && !allowedCreation.includes(role)) {
    return res.status(403).json({ error: `No tienes permiso para crear usuarios con rol: ${role}` });
  }

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true
    });
    if (authError) return res.status(400).json({ error: authError.message });

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({ auth_id: authData.user.id, email, full_name, phone, role, cliente_id })
      .select().single();
    if (userError) return res.status(400).json({ error: userError.message });

    if (role === 'driver') {
      await supabaseAdmin.from('drivers').insert({ user_id: user.id });
    }

    res.status(201).json({ message: 'Usuario creado', user });
  } catch(e) {
    console.error('Create user error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── API Pública (autenticación por API Key) ────────────────────────────────
router.post('/api/orders/batch',
  apiKeyAuth('orders:create'),
  sanitize,
  createBatch
)

// ─── Gestión de API Keys (autenticación por sesión JWT) ─────────────────────
router.get ('/client/api-keys',           authenticate, requireRole('client','admin'), listApiKeys)
router.post('/client/api-keys',           authenticate, requireRole('client','admin'), sanitize, createApiKey)
router.delete('/client/api-keys/:id',     authenticate, requireRole('client','admin'), revokeApiKey)

// ─── Webhooks ────────────────────────────────────────────────────────────────
router.post('/client/webhooks',           authenticate, requireRole('client','admin'), sanitize, createWebhook)
router.post('/client/webhooks/:id/test',  authenticate, requireRole('client','admin'), testWebhook)

export default router;
