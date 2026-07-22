import { supabaseAdmin } from '../services/supabase.js';
import express from 'express';
import { login, register } from '../controllers/authController.js';
import { getOrders, getOrder, getOrderByQR, createOrder, updateStatus, confirmPickup, assignDriver, supervisorOverride, reassignOrder } from '../controllers/ordersController.js';
import { getMyOrders, getHistory, updateDriverStatus, updateLocation, getAllDrivers, listClientDrivers, createClientDriver, setClientDriverActive, setClientDriverPassword } from '../controllers/driversController.js';
import { createPaymentIntent, stripeWebhook, getPaymentStatus } from '../controllers/paymentsController.js';
import { uploadPhoto, uploadSignature, uploadNote, confirmDeliveryWithProof, getEvidence, getEvidenceByType } from '../controllers/evidenceController.js';
import { authenticate, requireRole, sanitize, resetLoginAttempts, ROLE_GROUPS } from '../middleware/auth.js'
import { loginRateLimitRedis, getRateLimitStats } from '../middleware/rateLimitRedis.js'
import { apiKeyAuth } from '../middleware/apiKeyAuth.js'
import { createBatch, createApiKey, listApiKeys, revokeApiKey, createWebhook, testWebhook } from '../controllers/apiBatchController.js';
import { getOrderDetail } from '../controllers/orderDetailController.js';
import { getShipmentStatuses, reportFailed } from '../controllers/shipmentStatusController.js';
import { scanReceive, getMyReceptions, getPendingReceptions, confirmReception, rejectReception } from '../controllers/packageReceptionsController.js';
import { createVehicle, getMyVehicles, deactivateVehicle, getClientSubscription, patchVehicleLimit, subscriptionWebhook } from '../controllers/vehiclesController.js';
import { addRouteGuide, getRouteGuides, removeRouteGuide } from '../controllers/routeGuidesController.js';
import { createRoute, listRoutes, getRoute, addRouteItem, removeRouteItem, optimizeRoute, updateRouteStatus, assignRouteDriver } from '../controllers/routesController.js';
import { requireActiveSubscription } from '../middleware/requireActiveSubscription.js';

const router = express.Router();

// ─── Auth ───────────────────────────────────────────────────────────────────
router.post('/auth/login',    loginRateLimitRedis, sanitize, login);
router.post('/auth/register', authenticate, requireRole(...ROLE_GROUPS.admin_only), sanitize, register);

// ─── Órdenes (cliente) ──────────────────────────────────────────────────────
router.get ('/orders',          authenticate, getOrders);
router.get ('/orders/qr/:code',             authenticate, getOrderByQR);
router.get ('/orders/:trackingCode/detail', authenticate, getOrderDetail);
router.get ('/orders/:id',                 authenticate, getOrder);
router.post('/orders',          authenticate, requireRole('client','admin','supervisor','gerente_comercial','gerente_operaciones'), sanitize, createOrder);

// ─── Catálogo de estados ────────────────────────────────────────────────────
router.get ('/shipment-statuses',           getShipmentStatuses);
router.post('/orders/:id/report-failed',    authenticate, requireRole('driver'), reportFailed);

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

// ─── Recepción de paquetes (escaneo sin asignación) ────────────────────────
router.post('/driver/scan-receive', authenticate, requireRole('driver'), sanitize, scanReceive);
router.get ('/driver/receptions',   authenticate, requireRole('driver'), getMyReceptions);

router.get ('/admin/receptions/pending',    authenticate, requireRole(...ROLE_GROUPS.ops), getPendingReceptions);
router.post('/admin/receptions/:id/confirm', authenticate, requireRole(...ROLE_GROUPS.ops), confirmReception);
router.post('/admin/receptions/:id/reject',  authenticate, requireRole(...ROLE_GROUPS.ops), sanitize, rejectReception);

// ─── Suscripción por vehículo (placas) ──────────────────────────────────────
// Cliente autenticado: alta/baja/listado de sus placas. El tope se hace
// cumplir en DB (trigger enforce_vehicle_limit) → alta excedida = 409.
router.get   ('/vehicles',      authenticate, requireRole('client'), getMyVehicles);
router.post  ('/vehicles',      authenticate, requireRole('client'), requireActiveSubscription, sanitize, createVehicle);
router.delete('/vehicles/:id',  authenticate, requireRole('client'), deactivateVehicle);

// Staff comercial/admin: vista de suscripción y override manual del tope.
// vehicle_limit:write restringido a admin y gerente_comercial.
router.get  ('/clients/:clientId/subscription',   authenticate, requireRole('admin','gerente_comercial'), getClientSubscription);
router.patch('/clients/:clientId/vehicle-limit',  authenticate, requireRole('admin','gerente_comercial'), sanitize, patchVehicleLimit);

// Webhook del proveedor de pago (auth por secreto compartido, sin JWT).
router.post('/webhooks/subscription', subscriptionWebhook);

// ─── Rutas (builder de ruteo por suscripción) ────────────────────────────────
router.get   ('/routes',                 authenticate, requireRole('client'), listRoutes);
router.post  ('/routes',                 authenticate, requireRole('client'), requireActiveSubscription, sanitize, createRoute);
router.get   ('/routes/:id',             authenticate, requireRole('client'), getRoute);
router.patch ('/routes/:id/status',      authenticate, requireRole('client'), sanitize, updateRouteStatus);
router.post  ('/routes/:id/optimize',    authenticate, requireRole('client'), optimizeRoute);
router.post  ('/routes/:id/items',       authenticate, requireRole('client'), requireActiveSubscription, sanitize, addRouteItem);
router.delete('/routes/:id/items/:itemId', authenticate, requireRole('client'), removeRouteItem);
router.patch ('/routes/:id/driver',      authenticate, requireRole('client'), sanitize, assignRouteDriver);

// ─── Conductores del cliente (flota propia) ──────────────────────────────────
router.get  ('/client/drivers', authenticate, requireRole('client'), listClientDrivers);
router.post ('/client/drivers', authenticate, requireRole('client'), sanitize, createClientDriver);
router.patch('/client/drivers/:id',          authenticate, requireRole('client'), sanitize, setClientDriverActive);
router.patch('/client/drivers/:id/password', authenticate, requireRole('client'), sanitize, setClientDriverPassword);

// ─── Multi-guía por parada (route_items) ─────────────────────────────────────
router.get   ('/route-stops/:stopId/guides',                authenticate, getRouteGuides);
router.post  ('/route-stops/:stopId/guides',                authenticate, requireActiveSubscription, sanitize, addRouteGuide);
router.delete('/route-stops/:stopId/guides/:guideLinkId',   authenticate, removeRouteGuide);

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
