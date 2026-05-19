import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../services/supabase.js';

// Verifica el token JWT en cada petición protegida
export const authenticate = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const token = auth.split(' ')[1];

    // Verificar el token directamente con Supabase
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !authUser) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    // Cargar datos del usuario desde la tabla users
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

// Restringe acceso por rol
export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
};
// Sanitiza inputs para prevenir XSS y ataques de inyeccion
export const sanitize = (req, res, next) => {
  const clean = (obj) => {
    if (!obj || typeof obj !== 'object') return
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        obj[key] = obj[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/[<>]/g, '')
          .trim()
      } else if (typeof obj[key] === 'object') {
        clean(obj[key])
      }
    }
  }
  clean(req.body)
  clean(req.query)
  next()
}