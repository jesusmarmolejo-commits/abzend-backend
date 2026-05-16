import { supabaseAdmin } from '../services/supabase.js';
import express from 'express';
import { login, register } from '../controllers/authController.js';
import { getOrders, getOrder, getOrderByQR, createOrder, updateStatus, confirmPickup, assignDriver } from '../controllers/ordersController.js';
import { getMyOrders, getHistory, updateDriverStatus, updateLocation, getAllDrivers } from '../controllers/driversController.js';
import { createPaymentIntent, stripeWebhook, getPaymentStatus } from '../controllers/paymentsController.js';
import { authenticate, requireRole, sanitize } from '../middleware/auth.js';
import { suggestDriverAssignment, generateStatusMessage, analyzeDelay, getDailySummary } from '../controllers/aiController.js';

const router = express.Router();

// ─── Auth ───────────────────────────────────────
router.post('/auth/login',    sanitize, login);
router.post('/auth/register', authenticate, requireRole('admin'), sanitize, register);

// ─── Órdenes (cliente) ─────────────────────────
router.get ('/orders',            authenticate, getOrders);
router.get ('/orders/qr/:code',   authenticate, requireRole('driver', 'admin'), getOrderByQR);
router.get ('/orders/:id',        authenticate, getOrder);
router.post('/orders',            authenticate, requireRole('client', 'admin'), sanitize, createOrder);

// ─── Órdenes (repartidor) ──────────────────────
router.post ('/orders/:id/pickup',  authenticate, requireRole('driver', 'admin'), confirmPickup);
router.patch('/orders/:id/status',  authenticate, requireRole('driver', 'admin'), updateStatus);

// ─── Admin ─────────────────────────────────────
router.post('/admin/orders/:id/assign', authenticate, requireRole('admin'), assignDriver);
router.get ('/admin/drivers',           authenticate, requireRole('admin'), getAllDrivers);

// ─── Repartidor (móvil) ────────────────────────
router.get  ('/driver/orders',   authenticate, requireRole('driver'), getMyOrders);
router.get  ('/driver/history',  authenticate, requireRole('driver'), getHistory);
router.patch('/driver/status',   authenticate, requireRole('driver'), updateDriverStatus);
router.post ('/driver/location', authenticate, requireRole('driver'), updateLocation);

// ─── IA / DeepSeek ─────────────────────────────
router.post('/ai/assign-driver',  authenticate, requireRole('admin'), suggestDriverAssignment);
router.post('/ai/status-message', authenticate, requireRole('driver', 'admin'), generateStatusMessage);
router.post('/ai/delay-analysis', authenticate, requireRole('admin'), analyzeDelay);
router.get ('/ai/ops-summary',    authenticate, requireRole('admin'), getDailySummary);

// ─── Pagos / Stripe ────────────────────────────
// IMPORTANTE: el webhook de Stripe necesita el body RAW (sin parsear JSON)
router.post('/payments/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
router.post('/payments/intent',  authenticate, createPaymentIntent);
router.get ('/payments/order/:id', authenticate, getPaymentStatus);

// ─── Crear usuario desde panel admin ───────────
router.post('/admin/users', authenticate, requireRole('admin'), sanitize, async (req, res) => {
  const { email, password, full_name, phone, role = 'client' } = req.body
  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true
    })
    if (authError) return res.status(400).json({ error: 'No se pudo crear el usuario' })
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({ auth_id: authData.user.id, email, full_name, phone, role })
      .select().single()
    if (userError) return res.status(400).json({ error: 'No se pudo guardar el perfil del usuario' })
    if (role === 'driver') {
      await supabaseAdmin.from('drivers').insert({ user_id: user.id })
    }
    res.status(201).json({ message: 'Usuario creado', user })
  } catch(e) {
    console.error('Create user error:', e)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

export default router;
