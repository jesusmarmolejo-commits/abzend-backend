import Stripe from 'stripe';
import { supabaseAdmin } from '../services/supabase.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// POST /payments/intent — Crear intento de pago para una orden
export const createPaymentIntent = async (req, res) => {
  const { order_id } = req.body;

  try {
    // Obtener total de la orden
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('id, tracking_code, total, payment_status, client_id')
      .eq('id', order_id)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'La orden ya está pagada' });

    // Crear PaymentIntent en Stripe (monto en centavos)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(order.total * 100),
      currency: 'mxn',
      metadata: {
        order_id: order.id,
        tracking_code: order.tracking_code,
        client_id: order.client_id
      },
      description: `ABZEND Envío ${order.tracking_code}`
    });

    // Guardar el payment_intent_id en la orden
    await supabaseAdmin
      .from('orders')
      .update({ stripe_payment_intent_id: paymentIntent.id })
      .eq('id', order_id);

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: order.total,
      currency: 'MXN'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /payments/webhook — Stripe notifica cuando el pago se completa
export const stripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook inválido: ${err.message}` });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const order_id = pi.metadata.order_id;

    // Marcar orden como pagada en Supabase
    await supabaseAdmin
      .from('orders')
      .update({ payment_status: 'paid', status: 'pending' })
      .eq('id', order_id);

    console.log(`Pago confirmado para orden: ${order_id}`);
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    await supabaseAdmin
      .from('orders')
      .update({ payment_status: 'failed' })
      .eq('stripe_payment_intent_id', pi.id);
  }

  res.json({ received: true });
};

// GET /payments/order/:id — Estado del pago de una orden
export const getPaymentStatus = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('tracking_code, total, payment_status, stripe_payment_intent_id')
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Orden no encontrada' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
