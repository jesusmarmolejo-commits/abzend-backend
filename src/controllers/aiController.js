import { deepseekChat } from '../services/deepseek.js';
import { supabaseAdmin } from '../services/supabase.js';

/** Trunca dirección para no enviar datos innecesarios a la IA */
const truncAddr = (addr) =>
  !addr ? 'No especificada' : addr.length > 80 ? addr.slice(0, 77) + '...' : addr;

// ──────────────────────────────────────────────────────────
// POST /v1/ai/assign-driver   (admin only)
// ──────────────────────────────────────────────────────────
export async function suggestDriverAssignment(req, res) {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id requerido' });

    // Orden
    const { data: order, error: oErr } = await supabaseAdmin
      .from('orders')
      .select('origin_address, dest_address, package_type, weight_kg, service')
      .eq('id', order_id)
      .single();
    if (oErr || !order) return res.status(404).json({ error: 'Orden no encontrada' });

    // Repartidores online — última ubicación ya en drivers.last_lat / last_lng
    // FIX: status='online' (enum: online|offline|busy), join a users para el nombre
    const { data: drivers, error: dErr } = await supabaseAdmin
      .from('drivers')
      .select('id, last_lat, last_lng, last_seen_at, user:users!user_id(full_name)')
      .eq('status', 'online');
    if (dErr) throw new Error(`Error obteniendo repartidores: ${dErr.message}`);

    const driverList = (drivers || []).map(d => {
      const loc = d.last_lat && d.last_lng
        ? `lat: ${d.last_lat}, lng: ${d.last_lng}`
        : 'ubicación desconocida';
      return `- ${d.user?.full_name || 'Sin nombre'}: ${loc}`;
    });

    const suggestion = await deepseekChat(
      `Orden a asignar:
Origen:  ${truncAddr(order.origin_address)}
Destino: ${truncAddr(order.dest_address)}
Paquete: ${order.package_type || 'general'} | ${order.weight_kg ?? 0} kg | ${order.service || 'standard'}

Repartidores online:
${driverList.length ? driverList.join('\n') : 'Ninguno disponible'}

¿Qué repartidor recomiendas y por qué?`,
      'Eres un despachador de logística. Analiza la orden y los repartidores disponibles y sugiere la mejor asignación. Responde en español. Máximo 3 oraciones.',
      { temperature: 0.3 }
    );

    res.json({ suggestion, order_id, drivers_considered: driverList.length });
  } catch (err) {
    console.error('[AI] suggestDriverAssignment:', err);
    res.status(500).json({ error: err.message });
  }
}

// ──────────────────────────────────────────────────────────
// POST /v1/ai/status-message   (driver | admin)
// ──────────────────────────────────────────────────────────
export async function generateStatusMessage(req, res) {
  try {
    const { order_id, new_status } = req.body;
    const VALID = ['pending','assigned','picked_up','in_transit','delivered','failed','cancelled'];

    if (!order_id || !new_status) return res.status(400).json({ error: 'order_id y new_status requeridos' });
    if (!VALID.includes(new_status)) return res.status(400).json({ error: 'Estado no válido' });

    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('recipient_name, dest_address, service')
      .eq('id', order_id)
      .single();
    if (error || !order) return res.status(404).json({ error: 'Orden no encontrada' });

    const message = await deepseekChat(
      `Genera un mensaje de notificación para el cliente:
- Destinatario: ${order.recipient_name || 'Cliente'}
- Servicio: ${order.service || 'estándar'}
- Dirección: ${truncAddr(order.dest_address)}
- Nuevo estado: ${new_status}`,
      'Eres un asistente de mensajería. Escribe un mensaje breve y amable en español para notificar al cliente. Máximo 2 oraciones.',
      { temperature: 0.4 }
    );

    res.json({ message, status: new_status });
  } catch (err) {
    console.error('[AI] generateStatusMessage:', err);
    res.status(500).json({ error: err.message });
  }
}

// ──────────────────────────────────────────────────────────
// POST /v1/ai/delay-analysis   (admin only)
// ──────────────────────────────────────────────────────────
export async function analyzeDelay(req, res) {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id requerido' });

    // FIX: order_events tiene columnas status + note (no event_type ni metadata)
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('id, status, created_at, order_events(status, note, created_at)')
      .eq('id', order_id)
      .single();
    if (error || !order) return res.status(404).json({ error: 'Orden no encontrada' });

    const events = (order.order_events || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const lastEvent     = events.at(-1);
    const referenceTime = lastEvent ? new Date(lastEvent.created_at) : new Date(order.created_at);
    const minutesElapsed = Math.floor((Date.now() - referenceTime) / 60_000);

    // Umbrales de alerta
    const alertMap = {
      in_transit: [90,  'Paquete en tránsito sin actualización'],
      assigned:   [60,  'Orden asignada sin confirmar recolección'],
      pending:    [120, 'Orden pendiente sin asignar'],
    };
    const [threshold, reason] = alertMap[order.status] || [null, null];
    const alert = threshold != null && minutesElapsed > threshold;

    if (!alert) {
      return res.json({ alert: false, minutes_elapsed: minutesElapsed, message: 'Orden en tiempo normal' });
    }

    const history = events
      .map(e => `- ${e.status}${e.note ? ': ' + e.note : ''} (${new Date(e.created_at).toLocaleString()})`)
      .join('\n');

    const suggested_action = await deepseekChat(
      `Analiza este retraso logístico:
Estado: ${order.status} | Tiempo sin cambios: ${minutesElapsed} min | Umbral: ${threshold} min
Motivo de alerta: ${reason}

Historial:
${history || 'Sin eventos registrados'}

Proporciona análisis y acción concreta para resolver el retraso.`,
      'Eres un analista de operaciones logísticas. Responde en español. Sé específico y práctico. Máximo 3 oraciones.',
      { temperature: 0.3 }
    );

    res.json({ alert: true, minutes_elapsed: minutesElapsed, suggested_action });
  } catch (err) {
    console.error('[AI] analyzeDelay:', err);
    res.status(500).json({ error: err.message });
  }
}

// ──────────────────────────────────────────────────────────
// GET /v1/ai/ops-summary   (admin only)
// ──────────────────────────────────────────────────────────
export async function getDailySummary(req, res) {
  try {
    // FIX: usar UTC para coincidir con timestamps de Supabase
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('status, total, driver_id')
      .gte('created_at', startOfDay.toISOString());
    if (error) throw new Error(`Error obteniendo órdenes: ${error.message}`);

    // Acumular stats
    const stats = { pending: 0, assigned: 0, picked_up: 0, in_transit: 0, delivered: 0, failed: 0, cancelled: 0 };
    let totalRevenue = 0;
    const driverDeliveries = {};

    for (const o of orders) {
      if (o.status in stats) stats[o.status]++;
      if (o.status === 'delivered') {
        totalRevenue += parseFloat(o.total || 0);
        if (o.driver_id) driverDeliveries[o.driver_id] = (driverDeliveries[o.driver_id] || 0) + 1;
      }
    }

    // Top driver
    const topDriverId = Object.entries(driverDeliveries).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const maxDeliveries = topDriverId ? driverDeliveries[topDriverId] : 0;
    let topDriverName = 'N/A';

    if (topDriverId) {
      // FIX: drivers no tiene campo name — hay que join con users
      const { data: drv } = await supabaseAdmin
        .from('drivers')
        .select('user:users!user_id(full_name)')
        .eq('id', topDriverId)
        .single();
      topDriverName = drv?.user?.full_name || 'Desconocido';
    }

    const summary = await deepseekChat(
      `Resumen de operaciones del ${startOfDay.toLocaleDateString('es-MX')}:
Entregadas: ${stats.delivered} | En tránsito: ${stats.in_transit} | Asignadas: ${stats.assigned}
Pendientes: ${stats.pending}  | Fallidas: ${stats.failed} | Total: ${orders.length}
Ingresos del día: $${totalRevenue.toFixed(2)} MXN
Repartidor del día: ${topDriverName} con ${maxDeliveries} entregas`,
      'Eres un gerente de operaciones. Escribe un resumen ejecutivo breve en español para el dashboard. Sé específico con los números. Máximo 4 oraciones.',
      { temperature: 0.2 }
    );

    res.json({
      summary,
      raw_stats: {
        ...stats,
        total_orders: orders.length,
        total_revenue: totalRevenue,
        top_driver: { id: topDriverId, name: topDriverName, deliveries: maxDeliveries },
      },
    });
  } catch (err) {
    console.error('[AI] getDailySummary:', err);
    res.status(500).json({ error: err.message });
  }
}
