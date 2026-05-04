import { supabaseAdmin } from '../services/supabase.js';
import express from 'express';
import { login, register } from '../controllers/authController.js';
import { getOrders, getOrder, getOrderByQR, createOrder, updateStatus, confirmPickup, assignDriver } from '../controllers/ordersController.js';
import { getMyOrders, getHistory, updateDriverStatus, updateLocation, getAllDrivers } from '../controllers/driversController.js';
import { createPaymentIntent, stripeWebhook, getPaymentStatus } from '../controllers/paymentsController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

// ─── Auth ───────────────────────────────────────
router.post('/auth/login',    login);
router.post('/auth/register', authenticate, requireRole('admin'), register);

// ─── Órdenes (cliente) ─────────────────────────
router.get ('/orders',            authenticate, getOrders);
router.get ('/orders/qr/:code',   authenticate, getOrderByQR);
router.get ('/orders/:id',        authenticate, getOrder);
router.post('/orders',            authenticate, requireRole('client', 'admin'), createOrder);

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

// ─── Pagos / Stripe ────────────────────────────
router.post('/payments/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
router.post('/payments/intent',  authenticate, createPaymentIntent);
router.get ('/payments/order/:id', authenticate, getPaymentStatus);

// ─── Crear usuario desde panel admin ───────────
router.post('/admin/users', async (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'No autorizado' })
  }
  const { email, password, full_name, phone, role = 'client' } = req.body
  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true
    })
    if (authError) return res.status(400).json({ error: authError.message })
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({ auth_id: authData.user.id, email, full_name, phone, role })
      .select().single()
    if (userError) return res.status(400).json({ error: userError.message })
    if (role === 'driver') {
      await supabaseAdmin.from('drivers').insert({ user_id: user.id })
    }
    res.status(201).json({ message: 'Usuario creado', user })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

export default router;