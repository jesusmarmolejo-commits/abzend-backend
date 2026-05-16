import express from 'express';
import { login, register } from '../controllers/authController.js';
import { getOrders, getOrder, getOrderByQR, createOrder, updateStatus, confirmPickup, assignDriver } from '../controllers/ordersController.js';
import { getMyOrders, getHistory, updateDriverStatus, updateLocation, getAllDrivers } from '../controllers/driversController.js';
import { createPaymentIntent, stripeWebhook, getPaymentStatus } from '../controllers/paymentsController.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { suggestDriverAssignment, generateStatusMessage, analyzeDelay, getDailySummary } from '../controllers/aiController.js';

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

export default router;
