import { supabaseAdmin } from '../services/supabase.js';

// POST /driver/scan-receive — Repartidor escanea un paquete (sin asignación)
export const scanReceive = async (req, res) => {
  const { qr_code } = req.body;
  if (!qr_code || !qr_code.trim()) {
    return res.status(400).json({ error: 'qr_code requerido' });
  }

  try {
    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id').eq('user_id', req.user.id).single();

    if (!driver) return res.status(404).json({ error: 'Perfil de repartidor no encontrado' });

    const { data: existing } = await supabaseAdmin
      .from('package_receptions')
      .select('id')
      .eq('qr_code', qr_code)
      .eq('driver_id', driver.id)
      .eq('status', 'pending_station_validation')
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Ya existe una recepción pendiente para este código' });
    }

    const { data, error } = await supabaseAdmin
      .from('package_receptions')
      .insert({ qr_code, driver_id: driver.id })
      .select('id, qr_code, status')
      .single();

    if (error) throw error;

    res.status(201).json({
      reception_id: data.id,
      qr_code: data.qr_code,
      status: data.status,
      message: 'Recepción registrada. Pendiente validación de estación.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /driver/receptions — Historial de recepciones del repartidor
export const getMyReceptions = async (req, res) => {
  try {
    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id').eq('user_id', req.user.id).single();

    if (!driver) return res.status(404).json({ error: 'Perfil de repartidor no encontrado' });

    const { data, error } = await supabaseAdmin
      .from('package_receptions')
      .select('id, qr_code, status, driver_scanned_at, station_validated_at, notes, created_at')
      .eq('driver_id', driver.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ receptions: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /admin/receptions/pending — Recepciones pendientes de validación
export const getPendingReceptions = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('package_receptions')
      .select('id, qr_code, status, driver_scanned_at, driver:drivers(id, user:users(full_name))')
      .eq('status', 'pending_station_validation')
      .order('driver_scanned_at', { ascending: true });

    if (error) throw error;

    res.json({ receptions: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /admin/receptions/:id/confirm — Estación confirma recepción
export const confirmReception = async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabaseAdmin
      .from('package_receptions')
      .update({
        status: 'confirmed',
        station_validated_at: new Date(),
        station_user_id: req.user.id
      })
      .eq('id', id)
      .eq('status', 'pending_station_validation')
      .select('id')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Recepción no encontrada o ya validada' });

    res.json({ message: 'Recepción confirmada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /admin/receptions/:id/reject — Estación rechaza recepción
export const rejectReception = async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  try {
    const { data, error } = await supabaseAdmin
      .from('package_receptions')
      .update({
        status: 'rejected',
        station_validated_at: new Date(),
        station_user_id: req.user.id,
        notes: notes || null
      })
      .eq('id', id)
      .eq('status', 'pending_station_validation')
      .select('id')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Recepción no encontrada o ya validada' });

    res.json({ message: 'Recepción rechazada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
