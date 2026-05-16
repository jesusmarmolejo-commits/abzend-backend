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
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Cargar datos del usuario desde Supabase
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, role')
      .eq('id', payload.userId)
      .single();

    if (error || !user) return res.status(401).json({ error: 'Usuario no encontrado' });

    req.user = user;
    next();
  } catch {
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
const MAX_STRING_LENGTH = 2000;

function cleanValue(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(/[<>"'&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '&': '&amp;' }[c]))
    .slice(0, MAX_STRING_LENGTH)
    .trim()
}

function sanitizeObj(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = cleanValue(obj[key])
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitizeObj(obj[key], depth + 1)
    }
  }
}

export const sanitize = (req, res, next) => {
  sanitizeObj(req.body)
  sanitizeObj(req.query)
  next()
}