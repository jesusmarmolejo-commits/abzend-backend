import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../services/supabase.js';

const signToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

// POST /auth/login
export const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Correo y contraseña requeridos' });

  try {
    // 1. Autenticar con Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (authError) return res.status(401).json({ error: 'Credenciales incorrectas' });

    // 2. Obtener perfil completo del usuario
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, role, phone')
      .eq('auth_id', authData.user.id)
      .single();

    if (userError || !user) return res.status(401).json({ error: 'Usuario no encontrado' });

    // 3. Si es repartidor, obtener datos del driver
    let driverData = null;
    if (user.role === 'driver') {
      const { data: driver } = await supabaseAdmin
        .from('drivers')
        .select('id, zone, status, rating, vehicle_type')
        .eq('user_id', user.id)
        .single();
      driverData = driver;
    }

    const token = signToken(user.id);
    res.json({ token, user: { ...user, driver: driverData } });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// POST /auth/register (solo admin puede crear cuentas de repartidor)
export const register = async (req, res) => {
  const { email, password, full_name, phone, role = 'client', zone } = req.body;

  try {
    // 1. Crear en Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true
    });
    if (authError) return res.status(400).json({ error: authError.message });

    // 2. Crear perfil en tabla users
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({ auth_id: authData.user.id, email, full_name, phone, role })
      .select()
      .single();

    if (userError) return res.status(400).json({ error: userError.message });

    // 3. Si es repartidor, crear registro en drivers
    if (role === 'driver') {
      await supabaseAdmin.from('drivers').insert({ user_id: user.id, zone });
    }

    res.status(201).json({ message: 'Usuario creado exitosamente', user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
