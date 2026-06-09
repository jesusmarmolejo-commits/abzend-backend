import { supabaseAdmin } from '../services/supabase.js';

// GET /v1/shipment-statuses
export const getShipmentStatuses = async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('shipment_statuses')
      .select('id, codigo, estado_es, estado_en, categoria')
      .order('id', { ascending: true });

    if (req.query.categoria) {
      query = query.eq('categoria', req.query.categoria);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching shipment statuses:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.json({ data });
  } catch (err) {
    console.error('Unexpected error in GET /v1/shipment-statuses:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// POST /v1/orders/:id/report-failed
export const reportFailed = async (req, res) => {
  try {
    const { id } = req.params;
    const { status_code, reason, photo_url, lat, lng, notes } = req.body;

    // Validate required fields
    if (!status_code || !reason || !photo_url || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Missing required fields: status_code, reason, photo_url, lat, lng' });
    }

    // Validate status_code exists in shipment_statuses
    const { data: statusData, error: statusError } = await supabaseAdmin
      .from('shipment_statuses')
      .select('id, codigo, estado_es, estado_en')
      .eq('codigo', status_code)
      .single();

    if (statusError || !statusData) {
      return res.status(400).json({ error: 'Invalid status_code' });
    }

    // Load order
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('id', id)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if already delivered
    if (order.status === 'delivered') {
      return res.status(409).json({ error: 'Order already delivered' });
    }

    // Lookup del perfil driver desde users.id
    const { data: driverRow, error: driverErr } = await supabaseAdmin
      .from('drivers')
      .select('id')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (driverErr || !driverRow) {
      return res.status(403).json({ error: 'No tienes un perfil de repartidor' });
    }

    if (order.driver_id !== driverRow.id) {
      return res.status(403).json({ error: 'Esta orden no te está asignada' });
    }

    // Geofence check (haversine 50m)
    if (order.dest_lat !== null && order.dest_lng !== null) {
      const R = 6371000;
      const dLat = (lat - order.dest_lat) * Math.PI / 180;
      const dLng = (lng - order.dest_lng) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(order.dest_lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance_m = R * c;
      const max_m = 50;

      if (distance_m > max_m) {
        return res.status(422).json({ error: 'Driver is too far from destination', distance_m, max_m });
      }
    }

    // Calculate attempt number
    const attemptNumber = (order.intentos_entrega || 0) + 1;

    // Insert delivery attempt
    const { error: attemptError } = await supabaseAdmin
      .from('delivery_attempts')
      .insert({
        order_id: id,
        attempt_number: attemptNumber,
        reason,
        photo_url,
        lat,
        lng,
        driver_id: driverRow.id,
        notes: notes || null
      });

    if (attemptError) {
      console.error('Error inserting delivery attempt:', attemptError);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const maxReached = attemptNumber >= 1;
    const newStatus = maxReached ? 'failed' : 'in_transit';

    const updateData = {
      intentos_entrega: attemptNumber,
      status: newStatus,
      rejection_reason: reason,
      status_updated_at: new Date().toISOString()
    };

    if (maxReached) {
      updateData.regreso_iniciado_at = new Date().toISOString();
    }

    const { error: updateError } = await supabaseAdmin
      .from('orders')
      .update(updateData)
      .eq('id', id);

    if (updateError) {
      console.error('Error updating order:', updateError);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const { error: eventError } = await supabaseAdmin
      .from('order_events')
      .insert({
        order_id: id,
        status: newStatus,
        status_code,
        note: reason,
        lat,
        lng,
        created_by: req.user.id
      });

    if (eventError) {
      console.error('Error inserting order event:', eventError);
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.json({
      attempt_number: attemptNumber,
      max_reached: maxReached,
      status: newStatus
    });

  } catch (err) {
    console.error('Unexpected error in POST /v1/orders/:id/report-failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
