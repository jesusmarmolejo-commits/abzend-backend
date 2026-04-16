import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import routes from './routes/index.js';
import { supabaseAdmin } from './services/supabase.js';

const app = express();
const httpServer = createServer(app);

// ─────────────────────────────────────────────
// Middleware de seguridad
// ─────────────────────────────────────────────
app.use(helmet());
app.use(morgan('dev'));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));

// Rate limiting — 100 requests por IP por 15 minutos
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Demasiadas peticiones' } }));

// Body parsers (el webhook de Stripe necesita raw antes de JSON)
app.use('/v1/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────
// Rutas API
// ─────────────────────────────────────────────
app.use('/v1', routes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// 404
app.use((req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.path}` }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ─────────────────────────────────────────────
// Supabase Realtime — suscripciones del servidor
// ─────────────────────────────────────────────
// Escucha cambios en driver_locations y los emite via log
// (En producción conectarías esto a WebSockets o SSE para el panel admin)
const setupRealtimeListeners = () => {
  supabaseAdmin
    .channel('driver-locations')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'driver_locations' }, (payload) => {
      console.log('[Realtime] Nueva ubicación:', payload.new.driver_id, payload.new.lat, payload.new.lng);
      // Aquí puedes emitir a WebSocket o Server-Sent Events para el mapa del admin
    })
    .subscribe();

  supabaseAdmin
    .channel('order-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, (payload) => {
      console.log('[Realtime] Orden actualizada:', payload.new.tracking_code, '→', payload.new.status);
    })
    .subscribe();
};

// ─────────────────────────────────────────────
// Iniciar servidor
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 ABZEND Backend corriendo en http://localhost:${PORT}`);
  console.log(`📦 Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Configurado' : 'NO configurado'}\n`);
  setupRealtimeListeners();
});

export default app;
