# 🔒 ABZEND Rate Limiting — Setup Automatizado

Sistema de protección contra **brute force**, **credential stuffing** y **DDoS de aplicación** usando Redis (Upstash).

## ⚡ Quick Start (2 minutos)

```bash
# 1. Instalar dependencias
npm install

# 2. Ejecutar setup automático
node scripts/setup-upstash.js

# 3. Completar .env con Supabase y Stripe (opcional)

# 4. Iniciar servidor
npm run dev
```

## 🎯 Qué hace el sistema

### Rate Limiting por IP
- **Límite**: 10 intentos fallidos en 15 minutos
- **Acción**: IP se bloquea por 10 minutos (429 Too Many Requests)
- **Persistencia**: Redis (Upstash) — persiste entre redeploys
- **Cleanup**: Automático, sin limpieza manual

### Detección de patrones de ataque
- **Botnet**: Múltiples IPs fallando rápidamente en el mismo rango (detecta `/24` subnet)
- **Attack Threshold**: 50 IPs diferentes fallando en 5 minutos
- **Logging**: Automático de intentos fallidos + User-Agent

### Información detallada
- IP del cliente
- Intentos fallidos por ventana
- Fecha/hora de bloqueo
- User-Agent del cliente

## 📋 Arquitectura

```
Request login
    ↓
[rateLimitRedis middleware]
    ↓
¿IP bloqueada? → 429 (Bloqueada)
    ↓
¿Excede 10 intentos? → 429 (Bloqueada)
    ↓
¿IP cercana a patrón de ataque? → Log warning
    ↓
[Pasar a login controller]
    ↓
¿Login exitoso? → resetLoginAttempts() → limpia contador
    ↓
Return token
```

## 🔧 Variables de entorno

```bash
# REQUERIDO para Redis
UPSTASH_REDIS_REST_URL=https://xxxxx-xxxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxxxx_xxxxx

# OPCIONAL — si no hay Redis, usa fallback en memoria (solo desarrollo)
```

### Obtener credenciales Upstash

1. Abre https://upstash.com
2. Clic en "Start Free" (sin tarjeta de crédito)
3. Verifica email + crea contraseña
4. Ve a "Redis" → "Create Database"
5. Nombre: "ABZEND", Region: "US-EAST-1" (o la más cercana)
6. Copia credenciales → `.env`

**El script `setup-upstash.js` valida automáticamente las credenciales.**

## 📊 Endpoints de monitoreo

### Ver estadísticas de rate limit (solo admin)

```bash
curl -X GET http://localhost:3000/v1/admin/rate-limit-stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Respuesta**:
```json
{
  "ip": "192.168.1.100",
  "current_attempts": 5,
  "max_attempts": 10,
  "remaining": 5,
  "window_minutes": 15,
  "recent_logs": [
    {
      "timestamp": 1717334400000,
      "userAgent": "Mozilla/5.0..."
    }
  ]
}
```

## 🧪 Pruebas

### Test 1: Rate limiting básico

```bash
# Script bash para simular 11 intentos fallidos
for i in {1..11}; do
  echo "Intento $i:"
  curl -X POST http://localhost:3000/v1/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}'
  echo ""
done
```

**Resultado esperado**:
- Intentos 1-10: 401 (credenciales inválidas)
- Intento 11: 429 (Too Many Requests) + mensaje de bloqueo

### Test 2: Reset tras login exitoso

```bash
# Login exitoso → contador se resetea
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"correct_password"}'

# Resultado: 200 + token válido
```

### Test 3: Patrones de ataque

```bash
# Simular múltiples IPs desde mismo rango (modificar X-Forwarded-For)
for ip in 192.168.1.{1..20}; do
  curl -X POST http://localhost:3000/v1/auth/login \
    -H "X-Forwarded-For: $ip" \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}'
done

# Logs mostrarán: "ATAQUE DETECTADO — Rango IP: 192.168.1.0/24"
```

## 🚨 Troubleshooting

### "Redis no está disponible"

**Causa**: Credenciales inválidas o Upstash no responde

**Solución**:
```bash
# Validar credenciales
UPSTASH_REDIS_REST_URL=... \
UPSTASH_REDIS_REST_TOKEN=... \
node -e "import('./src/middleware/rateLimitRedis.js').then(m => m.initializeRedis())"

# Si sigue fallando, revisa:
# 1. URL está correcta (sin typos)
# 2. Token no expiró (regenerar en Upstash)
# 3. Conexión internet funciona
```

**Fallback**: Si Redis falla, el middleware deja pasar requests (no bloquea) — es seguro para desarrollo.

### "IP no está bloqueada pero sigue rechazando"

**Causa**: Redis tiene datos desincronizados

**Solución**:
```bash
# Flushar Redis (CUIDADO: borra TODOS los datos)
curl -X POST https://xxxxx.upstash.io/flushall \
  -H "Authorization: Bearer $TOKEN"
```

### "Estoy bloqueado y no puedo acceder"

**Solución temporal** (desarrollo):
1. Espera 10 minutos (duración del bloqueo)
2. O usa otra IP / VPN
3. O desactiva rate limiting en `.env` (solo desarrollo):
   ```bash
   RATE_LIMIT_DISABLED=true
   ```

## 📈 Escalas de límites actuales

| Métrica | Valor | Ajustable |
|---------|-------|-----------|
| Max intentos por IP | 10 | En `rateLimitRedis.js` |
| Ventana de tiempo | 15 min | En `rateLimitRedis.js` |
| Duración de bloqueo | 10 min | En `rateLimitRedis.js` |
| Threshold ataque (IPs) | 50 | En `rateLimitRedis.js` |
| Threshold subnet | 20 | En `rateLimitRedis.js` |

### Personalizar límites

Edita `src/middleware/rateLimitRedis.js`:

```javascript
const RATE_LIMIT_CONFIG = {
  MAX_ATTEMPTS: 15,          // Cambiar a 15
  WINDOW_MS: 10 * 60 * 1000, // Cambiar a 10 min
  // ... resto
};
```

## 🌍 Próximos pasos: Cloudflare (cuando tengas dominio)

Cuando registres `abzend.mx`:

1. **Apuntar DNS a Cloudflare**
   ```
   abzend.mx → Cloudflare nameservers
   ```

2. **Activar WAF + Rate Limiting**
   ```
   Cloudflare → Security → WAF Rules
   Rate Limit: /auth/login → 100 requests/5 min por IP
   ```

3. **Activar Bot Fight Mode**
   ```
   Security → Bot Management → Enable Bot Fight Mode
   ```

4. **Activar SSL**
   ```
   SSL/TLS → Full
   ```

**Benefit**: DDoS a nivel de red, bloqueo de bots automático, WAF rules.

## 📚 Documentación adicional

- [Upstash Docs](https://upstash.com/docs/redis)
- [Express Rate Limit](https://github.com/nfriedly/express-rate-limit)
- [Cloudflare WAF](https://developers.cloudflare.com/waf/)

## 🔐 Seguridad

- ✅ Redis con TLS (Upstash)
- ✅ IP cliente detectada correctamente (X-Forwarded-For)
- ✅ Tokens de Reset no almacenados (solo contadores)
- ✅ Expiración automática de claves Redis (TTL)
- ✅ Logging de intentos fallidos para auditoría

---

**Última actualización**: 2026-06-03  
**Versión**: 1.0 — Rate Limiting Automatizado con Upstash Redis
