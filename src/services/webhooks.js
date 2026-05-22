import crypto from 'crypto'
import { supabaseAdmin } from './supabase.js'

export function signPayload(secret, payload, timestamp) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex')
}

export async function dispatchWebhook(clientId, event, data) {
  const { data: configs } = await supabaseAdmin
    .from('webhook_configs')
    .select('*')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .contains('events', [event])

  if (!configs?.length) return

  for (const config of configs) {
    const { data: delivery } = await supabaseAdmin
      .from('webhook_deliveries')
      .insert({
        config_id:     config.id,
        event,
        payload:       data,
        status:        'pending',
        next_retry_at: new Date().toISOString(),
      })
      .select()
      .single()

    await sendWebhookDelivery(delivery, config)
  }
}

export async function sendWebhookDelivery(delivery, config) {
  const timestamp = Date.now().toString()
  const payloadStr = JSON.stringify(delivery.payload)
  const signature = signPayload(config.secret, payloadStr, timestamp)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(config.url, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':          'application/json',
        'X-ABZEND-Signature':    `sha256=${signature}`,
        'X-ABZEND-Timestamp':    timestamp,
        'X-ABZEND-Event':        delivery.event,
        'X-ABZEND-Delivery-ID':  delivery.id,
      },
      body: payloadStr,
    })
    clearTimeout(timeout)

    const success = res.ok
    await supabaseAdmin.from('webhook_deliveries').update({
      status:       success ? 'success' : 'failed',
      http_status:  res.status,
      attempts:     (delivery.attempts || 0) + 1,
      delivered_at: success ? new Date().toISOString() : null,
      next_retry_at: success ? null : nextRetry(delivery.attempts),
    }).eq('id', delivery.id)

  } catch (err) {
    clearTimeout(timeout)
    await supabaseAdmin.from('webhook_deliveries').update({
      status:        'failed',
      attempts:      (delivery.attempts || 0) + 1,
      next_retry_at: nextRetry(delivery.attempts),
    }).eq('id', delivery.id)
  }
}

function nextRetry(attempts) {
  const delays = [60, 300, 1800]
  const delay  = delays[attempts] || null
  if (!delay) return null
  return new Date(Date.now() + delay * 1000).toISOString()
}

export async function retryPendingWebhooks() {
  const { data: pending } = await supabaseAdmin
    .from('webhook_deliveries')
    .select('*, config:config_id(*)')
    .eq('status', 'failed')
    .lt('next_retry_at', new Date().toISOString())
    .lt('attempts', 3)
    .limit(50)

  for (const delivery of pending || []) {
    await sendWebhookDelivery(delivery, delivery.config)
  }
}
