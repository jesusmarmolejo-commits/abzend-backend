import crypto from 'crypto'
import { supabaseAdmin } from './supabase.js'

export function generateApiKey() {
  const prefix = 'abz_live_'
  const secret = crypto.randomBytes(24).toString('hex')
  const fullKey = prefix + secret
  const hash = crypto.createHash('sha256').update(fullKey).digest('hex')
  return { fullKey, prefix, hash }
}

export async function validateApiKey(rawKey) {
  if (!rawKey?.startsWith('abz_live_')) return null
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex')

  const { data: key } = await supabaseAdmin
    .from('api_keys')
    .select('*, client:client_id(id,email,full_name)')
    .eq('key_hash', hash)
    .eq('is_active', true)
    .single()

  if (!key) return null
  if (key.expires_at && new Date(key.expires_at) < new Date()) return null

  await supabaseAdmin.from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', key.id)

  return key
}

export function hasScope(key, scope) {
  return key.scopes?.includes(scope) || key.scopes?.includes('*')
}

export async function logRequest(apiKeyId, { endpoint, method, ip, statusCode, responseMs, idempotencyKey, requestSize }) {
  await supabaseAdmin.from('api_request_logs').insert({
    api_key_id:      apiKeyId,
    endpoint,
    method,
    ip_address:      ip || null,
    status_code:     statusCode,
    response_ms:     responseMs,
    idempotency_key: idempotencyKey || null,
    request_size:    requestSize || 0,
  })
}

export async function checkIdempotency(key, apiKeyId) {
  const { data } = await supabaseAdmin
    .from('idempotency_keys')
    .select('response')
    .eq('key', key)
    .eq('api_key_id', apiKeyId)
    .gt('expires_at', new Date().toISOString())
    .single()
  return data?.response || null
}

export async function saveIdempotency(key, apiKeyId, response) {
  await supabaseAdmin.from('idempotency_keys').upsert({
    key,
    api_key_id: apiKeyId,
    response,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  })
}
