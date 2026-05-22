import crypto from 'crypto'
import { supabaseAdmin } from '../services/supabase.js'
import { dispatchWebhook } from '../services/webhooks.js'
import { checkIdempotency, saveIdempotency } from '../services/apiKeys.js'

const MAX_BATCH = 500
const MAX_PAYLOAD_KB = 1024

function validateOrder(o, idx) {
  const errors = []
  if (!o.sender_name?.trim())    errors.push(`[${idx}] sender_name requerido`)
  if (!o.origin_address?.trim()) errors.push(`[${idx}] origin_address requerido`)
  if (!o.recipient_name?.trim()) errors.push(`[${idx}] recipient_name requerido`)
  if (!o.dest_address?.trim())   errors.push(`[${idx}] dest_address requerido`)
  if (o.weight_kg !== undefined && (isNaN(o.weight_kg) || o.weight_kg <= 0))
    errors.push(`[${idx}] weight_kg inválido`)
  return errors
}

export const createBatch = async (req, res) => {
  const { orders } = req.body
  const idempotencyKey = req.headers['idempotency-key']

  if (!Array.isArray(orders) || orders.length === 0)
    return res.status(400).json({ error: 'orders debe ser un array no vacío' })

  if (orders.length > MAX_BATCH)
    return res.status(400).json({ error: `Máximo ${MAX_BATCH} órdenes por batch` })

  const payloadSize = JSON.stringify(req.body).length / 1024
  if (payloadSize > MAX_PAYLOAD_KB)
    return res.status(413).json({ error: `Payload excede ${MAX_PAYLOAD_KB}KB` })

  // Idempotency check
  if (idempotencyKey) {
    const cached = await checkIdempotency(idempotencyKey, req.apiKey.id)
    if (cached) return res.status(200).json({ ...cached, idempotent: true })
  }

  // Validar todas las órdenes
  const allErrors = orders.flatMap((o, i) => validateOrder(o, i + 1))
  if (allErrors.length) return res.status(422).json({ error: 'Validación fallida', details: allErrors })

  const created = []
  const failed  = []

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]
    try {
      const subtotal = Number(o.subtotal || 95)
      const tax      = Number((subtotal * 0.16).toFixed(2))
      const total    = Number((subtotal + tax).toFixed(2))

      const { data, error } = await supabaseAdmin.from('orders').insert({
        client_id:      req.apiKey.client.id,
        sender_name:    o.sender_name.trim(),
        sender_phone:   o.sender_phone?.trim() || null,
        origin_address: o.origin_address.trim(),
        recipient_name: o.recipient_name.trim(),
        recipient_phone:o.recipient_phone?.trim() || null,
        dest_address:   o.dest_address.trim(),
        weight_kg:      o.weight_kg || null,
        package_type:   o.package_type || 'general',
        instructions:   o.instructions?.trim() || null,
        service:        o.service || 'standard',
        subtotal,
        tax,
        total,
        status:         'pending',
      }).select('id, tracking_code').single()

      if (error) throw error
      created.push({ index: i + 1, id: data.id, tracking_code: data.tracking_code })

      // Disparar webhook order.created
      dispatchWebhook(req.apiKey.client.id, 'order.created', {
        event:         'order.created',
        tracking_code: data.tracking_code,
        order_id:      data.id,
        timestamp:     new Date().toISOString(),
      }).catch(() => {})

    } catch (err) {
      failed.push({ index: i + 1, error: err.message })
    }
  }

  const response = {
    created: created.length,
    failed:  failed.length,
    orders:  created,
    ...(failed.length ? { errors: failed } : {}),
  }

  if (idempotencyKey) {
    await saveIdempotency(idempotencyKey, req.apiKey.id, response)
  }

  return res.status(201).json(response)
}

export const createApiKey = async (req, res) => {
  const { name, scopes = ['orders:create','orders:read'], expires_at } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'name requerido' })

  const prefix = 'abz_live_'
  const secret = crypto.randomBytes(24).toString('hex')
  const fullKey = prefix + secret
  const hash    = crypto.createHash('sha256').update(fullKey).digest('hex')

  const { data, error } = await supabaseAdmin.from('api_keys').insert({
    client_id:  req.user.id,
    name:       name.trim(),
    key_prefix: prefix,
    key_hash:   hash,
    scopes,
    expires_at: expires_at || null,
  }).select('id, name, key_prefix, scopes, created_at').single()

  if (error) return res.status(400).json({ error: error.message })

  // Devolver la key SOLO en este momento — no se puede recuperar después
  return res.status(201).json({
    ...data,
    api_key: fullKey,
    warning: 'Guarda esta API key ahora. No podrás verla de nuevo.',
  })
}

export const listApiKeys = async (req, res) => {
  const { data } = await supabaseAdmin.from('api_keys')
    .select('id, name, key_prefix, scopes, is_active, last_used_at, expires_at, created_at')
    .eq('client_id', req.user.id)
    .order('created_at', { ascending: false })
  res.json({ keys: data || [] })
}

export const revokeApiKey = async (req, res) => {
  const { id } = req.params
  const { error } = await supabaseAdmin.from('api_keys')
    .update({ is_active: false })
    .eq('id', id)
    .eq('client_id', req.user.id)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ revoked: true })
}

export const createWebhook = async (req, res) => {
  const { url, events, secret } = req.body
  if (!url?.startsWith('https://')) return res.status(400).json({ error: 'URL debe ser HTTPS' })
  if (!Array.isArray(events) || !events.length) return res.status(400).json({ error: 'events requerido' })
  if (!secret || secret.length < 16) return res.status(400).json({ error: 'secret mínimo 16 caracteres' })

  const { data, error } = await supabaseAdmin.from('webhook_configs').insert({
    client_id: req.user.id,
    url,
    events,
    secret,
  }).select('id, url, events, is_active, created_at').single()

  if (error) return res.status(400).json({ error: error.message })
  res.status(201).json(data)
}

export const testWebhook = async (req, res) => {
  const { id } = req.params
  const { data: config } = await supabaseAdmin.from('webhook_configs')
    .select('*').eq('id', id).eq('client_id', req.user.id).single()

  if (!config) return res.status(404).json({ error: 'Webhook no encontrado' })

  const timestamp = Date.now().toString()
  const payload   = JSON.stringify({ event: 'webhook.test', timestamp })
  const sig       = crypto.createHmac('sha256', config.secret).update(`${timestamp}.${payload}`).digest('hex')

  try {
    const r = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'X-ABZEND-Signature':   `sha256=${sig}`,
        'X-ABZEND-Timestamp':   timestamp,
        'X-ABZEND-Event':       'webhook.test',
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    })
    res.json({ ok: r.ok, status: r.status })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
}
