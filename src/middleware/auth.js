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
