import { validateApiKey, hasScope, logRequest } from '../services/apiKeys.js'

const rateLimitMap = new Map()

export const apiKeyAuth = (requiredScope) => async (req, res, next) => {
  const start = Date.now()
  const raw   = req.headers.authorization?.replace('Bearer ', '')

  if (!raw) return res.status(401).json({ error: 'API key requerida' })

  const key = await validateApiKey(raw)
  if (!key)  return res.status(401).json({ error: 'API key inválida o expirada' })

  if (requiredScope && !hasScope(key, requiredScope))
    return res.status(403).json({ error: `Scope requerido: ${requiredScope}` })

  // IP allowlist
  if (key.ip_allowlist?.length) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
    if (!key.ip_allowlist.includes(ip))
      return res.status(403).json({ error: 'IP no autorizada para esta API key' })
  }

  // Rate limiting por key
  const now     = Date.now()
  const rlKey   = `rl:${key.id}`
  const record  = rateLimitMap.get(rlKey) || { count: 0, resetAt: now + 60_000 }
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + 60_000 }
  if (record.count >= (key.rate_limit || 100)) {
    return res.status(429).json({ error: 'Rate limit excedido', retry_after: Math.ceil((record.resetAt - now) / 1000) })
  }
  record.count++
  rateLimitMap.set(rlKey, record)

  req.apiKey  = key
  req.clientId = key.client_id

  res.on('finish', () => {
    logRequest(key.id, {
      endpoint:       req.path,
      method:         req.method,
      ip:             req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
      statusCode:     res.statusCode,
      responseMs:     Date.now() - start,
      idempotencyKey: req.headers['idempotency-key'],
      requestSize:    parseInt(req.headers['content-length'] || '0'),
    }).catch(() => {})
  })

  next()
}
