import { supabaseAdmin } from '../services/supabase.js';
import { ROLE_GROUPS } from '../middleware/auth.js';

// Calcular distancia (Haversine) para geofence
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// 🔒 SECURITY: Verifica que el usuario tenga acceso a la evidencia de esta orden (IDOR fix)
export async function verifyOrderAccess(orderId, user) {
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select('id, client_id, driver_id')
    .eq('id', orderId)
    .single();

  if (error || !order) return null;

  if (ROLE_GROUPS.all_staff.includes(user.role)) return order;

  if (user.role === 'client') {
    return order.client_id === user.id ? order : null;
  }

  if (user.role === 'driver') {
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('id')
      .eq('user_id', user.id)
      .single();

    return driver && order.driver_id === driver.id ? order : null;
  }

  return null;
}

// Helper: Subir archivo a Supabase Storage
async function uploadToStorage(bucket, path, base64Data, contentType) {
  try {
    const buffer = Buffer.from(base64Data.split(',')[1] || base64Data, 'base64');

    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .upload(path, buffer, {
        contentType,
        upsert: false,
        cacheControl: '3600'
      });

    if (error) throw error;

    const { data: urlData } = supabaseAdmin.storage
      .from(bucket)
      .getPublicUrl(data.path);

    return urlData.publicUrl;
  } catch (err) {
    console.error('Upload error:', err.message);
    throw new Error(`Error subiendo archivo: ${err.message}`);
  }
}

// POST /v1/orders/:id/evidence/photo
export const uploadPhoto = async (req, res) => {
  const { id: orderId } = req.params;
  const { photoBase64 } = req.body;

  if (!photoBase64) {
    return res.status(400).json({ error: 'Foto requerida' });
  }

  try {
    // Validar que la orden existe
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('id, status')
      .eq('id', orderId)
      .single();

    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    if (order.status === 'delivered') {
      return res.status(400).json({ error: 'Orden ya ha sido entregada' });
    }

    // Subir foto
    const timestamp = Date.now();
    const filename = `photos/${orderId}/${timestamp}_${req.user.id}.jpg`;
    const photoUrl = await uploadToStorage('delivery-evidence', filename, photoBase64, 'image/jpeg');

    // Guardar en BD
    const { data: evidence, error: insertError } = await supabaseAdmin
      .from('delivery_evidence')
      .insert({
        order_id: orderId,
        evidence_type: 'photo',
        photo_image_url: photoUrl,
        captured_by: req.user.id,
        captured_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) throw insertError;

    console.log(`Foto guardada para orden ${orderId}`);
    res.json({ success: true, evidence, photoUrl });
  } catch (err) {
    console.error('Error uploadPhoto:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /v1/orders/:id/evidence/signature
export const uploadSignature = async (req, res) => {
  const { id: orderId } = req.params;
  const { signatureBase64 } = req.body;

  if (!signatureBase64) {
    return res.status(400).json({ error: 'Firma requerida' });
  }

  try {
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('id, status')
      .eq('id', orderId)
      .single();

    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.status === 'delivered') return res.status(400).json({ error: 'Orden ya entregada' });

    // Subir firma
    const timestamp = Date.now();
    const filename = `signatures/${orderId}/${timestamp}_${req.user.id}.png`;
    const signatureUrl = await uploadToStorage('delivery-evidence', filename, signatureBase64, 'image/png');

    // Guardar en BD
    const { data: evidence, error: insertError } = await supabaseAdmin
      .from('delivery_evidence')
      .insert({
        order_id: orderId,
        evidence_type: 'signature',
        signature_image_url: signatureUrl,
        captured_by: req.user.id,
        captured_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) throw insertError;

    console.log(`Firma guardada para orden ${orderId}`);
    res.json({ success: true, evidence, signatureUrl });
  } catch (err) {
    console.error('Error uploadSignature:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /v1/orders/:id/evidence/note
export const uploadNote = async (req, res) => {
  const { id: orderId } = req.params;
  const { note } = req.body;

  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'Nota requerida' });
  }

  try {
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('id, status')
      .eq('id', orderId)
      .single();

    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.status === 'delivered') return res.status(400).json({ error: 'Orden ya entregada' });

    // Guardar nota
    const { data: evidence, error: insertError } = await supabaseAdmin
      .from('delivery_evidence')
      .insert({
        order_id: orderId,
        evidence_type: 'note',
        delivery_note: note.trim(),
        captured_by: req.user.id,
        captured_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) throw insertError;

    console.log(`Nota guardada para orden ${orderId}`);
    res.json({ success: true, evidence });
  } catch (err) {
    console.error('Error uploadNote:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /v1/orders/:id/confirm-with-proof (TRANSACCIÓN ATÓMICA)
export const confirmDeliveryWithProof = async (req, res) => {
  const { id: orderId } = req.params;
  const { photoBase64, signatureBase64, deliveryNote, lat, lng, receiverName, receiverType } = req.body;

  if (!photoBase64 || !signatureBase64) {
    return res.status(400).json({ error: 'Se requieren foto y firma' });
  }

  try {
    // 1. Obtener orden con destino
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('*, client:users!client_id(full_name, email)')
      .eq('id', orderId)
      .single();

    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.status === 'delivered') return res.status(400).json({ error: 'Orden ya entregada' });

    // 2. Geocerca: NO bloquea la entrega (decision Jesus, 2026-07-22). Puede
    //    haber señal GPS débil o el domicilio mal geocodificado; se permite
    //    entregar y se REGISTRA la distancia + la marca de fuera de cobertura.
    const COVERAGE_RADIUS_M = 10;
    let distanceMeters = null;
    let outOfCoverage = false;
    if (lat && lng && order.dest_lat && order.dest_lng) {
      distanceMeters = getDistanceKm(lat, lng, order.dest_lat, order.dest_lng) * 1000;
      outOfCoverage = distanceMeters > COVERAGE_RADIUS_M;
    }

    // 3. Subir fotos en paralelo
    const [photoUrl, signatureUrl] = await Promise.all([
      uploadToStorage('delivery-evidence', `photos/${orderId}/${Date.now()}_${req.user.id}.jpg`, photoBase64, 'image/jpeg'),
      uploadToStorage('delivery-evidence', `signatures/${orderId}/${Date.now()}_${req.user.id}.png`, signatureBase64, 'image/png')
    ]);

    // 4. Registrar evidencia completa en BD
    const { data: evidence, error: evidenceError } = await supabaseAdmin
      .from('delivery_evidence')
      .insert({
        order_id: orderId,
        evidence_type: 'complete',
        qr_code: order.qr_code,
        photo_image_url: photoUrl,
        signature_image_url: signatureUrl,
        delivery_note: deliveryNote || '',
        captured_by: req.user.id,
        captured_at: new Date().toISOString()
      })
      .select()
      .single();

    if (evidenceError) throw evidenceError;

    // 4.b Registrar la POD (proof_of_delivery) con la UBICACION GPS donde se
    //     cerro la entrega. receiver_name y receiver_type son NOT NULL, por eso
    //     llevan default si la app aun no los envia. Fail-soft: un problema aqui
    //     no debe tumbar la entrega ya registrada.
    const { data: pod, error: podError } = await supabaseAdmin
      .from('proof_of_delivery')
      .insert({
        order_id: orderId,
        receiver_name: receiverName || 'No especificado',
        receiver_type: receiverType || 'otro',
        photo_1: photoUrl,
        signature: signatureUrl,
        lat: lat ?? null,
        lng: lng ?? null,
        created_by: req.user.id
      })
      .select()
      .single();

    if (podError) console.error('Error registrando POD:', podError.message);

    // 5. Actualizar orden a 'delivered'
    const { data: updatedOrder, error: updateError } = await supabaseAdmin
      .from('orders')
      .update({
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        has_evidence: true,
        evidence_id: evidence.id,
        status_updated_at: new Date().toISOString()
      })
      .eq('id', orderId)
      .select()
      .single();

    if (updateError) throw updateError;

    // 6. Registrar evento de entrega
    const { error: eventError } = await supabaseAdmin
      .from('order_events')
      .insert({
        order_id: orderId,
        status: 'delivered',
        note: `✅ Entregado con evidencia (foto + firma + nota).` +
          (deliveryNote ? ` Nota: ${deliveryNote}` : '') +
          (distanceMeters != null
            ? ` · GPS a ${distanceMeters.toFixed(0)}m del destino${outOfCoverage ? ' — FUERA DE COBERTURA' : ''}`
            : ' · Sin coordenadas GPS'),
        lat: lat || null,
        lng: lng || null,
        created_by: req.user.id,
        created_at: new Date().toISOString()
      });

    if (eventError) console.error('Error registering event:', eventError);

    console.log(`Orden ${orderId} entregada con evidencia completa`);
    res.json({
      success: true,
      order: updatedOrder,
      evidence,
      pod: pod || null,
      out_of_coverage: outOfCoverage,
      distance_meters: distanceMeters != null ? Math.round(distanceMeters) : null,
      message: outOfCoverage
        ? '✅ Entrega confirmada FUERA DE COBERTURA'
        : '✅ Entrega confirmada con evidencia'
    });
  } catch (err) {
    console.error('Error confirmDeliveryWithProof:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// GET /v1/orders/:id/evidence
export const getEvidence = async (req, res) => {
  const { id: orderId } = req.params;

  try {
    const order = await verifyOrderAccess(orderId, req.user);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    const { data: evidence, error } = await supabaseAdmin
      .from('delivery_evidence')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ evidence, count: evidence.length });
  } catch (err) {
    console.error('Error getEvidence:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// GET /v1/orders/:id/evidence/:type (especíUfico)
export const getEvidenceByType = async (req, res) => {
  const { id: orderId, type } = req.params;
  const VALID_TYPES = ['photo', 'signature', 'qr', 'note', 'complete'];

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Tipo inválido: ${type}` });
  }

  try {
    const order = await verifyOrderAccess(orderId, req.user);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    const { data: evidence, error } = await supabaseAdmin
      .from('delivery_evidence')
      .select('*')
      .eq('order_id', orderId)
      .eq('evidence_type', type)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    res.json({ evidence: evidence || null });
  } catch (err) {
    console.error('Error getEvidenceByType:', err.message);
    res.status(500).json({ error: err.message });
  }
};
