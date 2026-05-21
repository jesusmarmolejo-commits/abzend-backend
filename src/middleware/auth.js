import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../services/supabase.js';

// Rate limiting en memoria para login (solución temporal sin dominio)
const loginAttempts = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutos

export const loginRateLimit = (req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
  const now = Date.now();
  const key = `login:${ip}`;
  const record = loginAttempts.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    return res.status(429).json({
      error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(retryAfter / 60)} minutos.`,
      retry_after: retryAfter
    });
  }

  record.count++;
  loginAttempts.set(key, record);

  // Limpiar entradas expiradas cada 1000 requests
  if (loginAttempts.size > 1000) {
    for (const [k, v] of loginAttempts.entries()) {
      if (now > v.resetAt) loginAttempts.delete(k);
    }
  }

  next();
};

// Resetear contador tras login exitoso
export const resetLoginAttempts = (ip) => {
  const key = `login:${ip}`;
  loginAttempts.delete(key);
};

export const authenticate = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const token = auth.split(' ')[1];
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !authUser) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, role')
      .eq('auth_id', authUser.id)
      .single();

    if (userError || !user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
};

// Roles permitidos por grupo
export const ROLE_GROUPS = {
  all_staff:   ['admin','supervisor','gerente_finanzas','gerente_comercial','gerente_operaciones','station'],
  management:  ['admin','supervisor','gerente_operaciones'],
  admin_only:  ['admin'],
  ops:         ['admin','supervisor','gerente_operaciones','station'],
  commercial:  ['admin','gerente_comercial','gerente_operaciones'],
  finance:     ['admin','gerente_finanzas'],
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({
      error: 'Acceso denegado',
      required: roles,
      current: req.user?.role
    });
  }
  next();
};

export const sanitize = (req, res, next) => {
  const clean = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        obj[key] = obj[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/[<>]/g, '')
          .trim();
      } else if (typeof obj[key] === 'object') {
        clean(obj[key]);
      }
    }
  };
  clean(req.body);
  clean(req.query);
  next();
};
