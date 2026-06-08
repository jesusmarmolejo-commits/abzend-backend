import { supabaseAdmin } from '../services/supabase.js';

export const getOrderDetail = async (req, res) => {
  try {
    const trackingCode = req.params.trackingCode;
    let order = null;
    let orderType = null;
    let ftlData = null;

    // Step 1: Try orders table if prefix matches known formats
    if (trackingCode.startsWith('TRK-') || trackingCode.startsWith('ABZ-')) {
      const { data: orderData, error: orderError } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('tracking_code', trackingCode)
        .single();

      if (!orderError && orderData) {
        order = orderData;
        orderType = trackingCode.startsWith('TRK-') ? 'LTL' : 'PAQUETERIA';

        // IDOR: clients may only see their own orders
        if (req.user.role === 'client' && order.client_id !== req.user.id) {
          return res.status(404).json({ error: 'Order not found' });
        }
      }
    }

    // Step 2: If not found in orders, try transport_orders (UUID-based FTL)
    if (!order) {
      const { data: transportOrder, error: transportError } = await supabaseAdmin
        .from('transport_orders')
        .select('*')
        .eq('id', trackingCode)
        .single();

      if (!transportError && transportOrder) {
        // FTL is B2B only
        if (req.user.role === 'client') {
          return res.status(403).json({ error: 'Access denied: FTL orders are B2B only' });
        }

        order = transportOrder;
        orderType = 'FTL';

        const { data: rates } = await supabaseAdmin
          .from('transport_rates')
          .select('*')
          .order('id', { ascending: true })
          .limit(1)
          .single();

        const maniobraMonto = order.maniobra && rates ? Number(rates.maniobra) : 0;
        const repartoMonto = order.reparto && rates ? Number(rates.reparto) : 0;
        const fleteFalsoMonto = order.incluye_flete_falso ? Number(order.tarifa_base) * 0.50 : 0;
        const totalEstimado = Number(order.tarifa_base) + maniobraMonto + repartoMonto + fleteFalsoMonto;

        ftlData = {
          ruta: order.ruta,
          unidad: order.unidad,
          tarifa_base: Number(order.tarifa_base),
          maniobra: order.maniobra,
          reparto: order.reparto,
          incluye_flete_falso: order.incluye_flete_falso,
          maniobra_monto: maniobraMonto,
          reparto_monto: repartoMonto,
          flete_falso_monto: order.incluye_flete_falso ? fleteFalsoMonto : null,
          total_estimado: totalEstimado
        };
      }
    }

    // Step 3: Nothing found in either table
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Resolve driver name via drivers -> users join
    let driverName = null;
    if (order.driver_id) {
      const { data: driverData } = await supabaseAdmin
        .from('drivers')
        .select('user_id')
        .eq('id', order.driver_id)
        .single();

      if (driverData) {
        const { data: userData } = await supabaseAdmin
          .from('users')
          .select('full_name')
          .eq('id', driverData.user_id)
          .single();

        if (userData) driverName = userData.full_name;
      }
    }

    // Fetch order events
    const { data: events } = await supabaseAdmin
      .from('order_events')
      .select('*')
      .eq('order_id', order.id)
      .order('created_at', { ascending: true });

    const formattedEvents = (events || []).map(event => ({
      id: event.id,
      timestamp: event.created_at,
      status: event.status,
      status_code: event.status_code || null,
      note: event.note || null,
      lat: event.lat || null,
      lng: event.lng || null
    }));

    // Fetch proof of delivery (PAQUETERIA/LTL only)
    let proofOfDelivery = null;
    if (orderType !== 'FTL') {
      const { data: evidence, error: evidenceError } = await supabaseAdmin
        .from('delivery_evidence')
        .select('*')
        .eq('order_id', order.id)
        .eq('evidence_type', 'complete')
        .single();

      if (!evidenceError && evidence) {
        proofOfDelivery = {
          delivered_at: order.delivered_at || null,
          photo_url: evidence.photo_image_url || null,
          signature_url: evidence.signature_image_url || null,
          delivery_note: evidence.delivery_note || null
        };
      }
      // null when no 'complete' evidence record exists
    }

    return res.status(200).json({
      order_type: orderType,
      tracking_code: orderType === 'FTL' ? order.id : order.tracking_code,
      status: order.status,
      created_at: order.created_at,
      service_type: order.service || null,
      origin: order.origin_address ? { address: order.origin_address } : null,
      destination: order.dest_address ? { address: order.dest_address } : null,
      weight_kg: order.weight_kg || null,
      estimated_delivery: order.estimated_delivery || null,
      driver: driverName ? { name: driverName } : null,
      ftl: ftlData,
      events: formattedEvents,
      proof_of_delivery: proofOfDelivery
    });
  } catch (error) {
    console.error('getOrderDetail error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
