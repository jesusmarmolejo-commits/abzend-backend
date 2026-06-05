import { Redis } from '@upstash/redis';

// Inicializar Redis (Upstash)
let redis = null;

export const initializeRedis = async () => {
  if (!redis && process.env.UPSTASH_REDIS_REST_URL) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    try {
      await redis.ping();
      console.log('✅ Redis (Upstash) conectado');
    } catch (e) {
      console.error('⚠️ Error conectando Redis:', e.message);
      redis = null;
    }
  }
  return redis;
};

// Configuración de rate limiting
const RATE_LIMIT_CONFIG = {
  // Intentos permitidos antes de bloqueo
  MAX_ATTEMPTS: 10,
  // Ventana de tiempo (15 minutos)
  WINDOW_MS: 15 * 60 * 1000,
  // Bloq temporal después de múltiples fallos (10 minutos)
  BLOCK_DURATION_MS: 10 * 60 * 1000,
  // Umbrales para detección de patrones de ataque
  ATTACK_DETECTION: {
    // Fallos rápidos desde múltiples IPs (patrón botnet)
    FAILED_IPS_THRESHOLD: 50,
    FAILED_IPS_WINDOW_MS: 5 * 60 * 1000, // 5 minutos
    // Fallos desde mismo rango IP (patrón de ataque coordinado)
    SUBNET_ATTACK_THRESHOLD: 20,
    SUBNET_ATTACK_WINDOW_MS: 5 * 60 * 1000,
  }
};

// Extraer IP cliente
const getClientIP = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0] ||
         req.headers['cf-connecting-ip'] ||
         req.socket.remoteAddress ||
         'unknown';
};

// Extraer rango de subnet (/24)
const getSubnet = (ip) => {
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return ip;
};

// Middleware de rate limiting con Redis
export const loginRateLimitRedis = async (req, res, next) => {
  try {
    const ip = getClientIP(req);
    const subnet = getSubnet(ip);
    const now = Date.now();

    // Clave para contar intentos por IP
    const ipKey = `login:attempts:${ip}`;
    // Clave para bloqueo temporal
    const ipBlockKey = `login:blocked:${ip}`;
    // Clave para detectar ataque (múltiples IPs)
    const attackKey = `login:attack:${subnet}`;
    // Clave para logging
    const logKey = `login:log:${ip}`;

    // Verificar si IP está bloqueada temporalmente
    if (redis) {
      const isBlocked = await redis.get(ipBlockKey);
      if (isBlocked) {
        const blockExpires = parseInt(isBlocked);
        const remainingMs = blockExpires - now;
        const remainingMin = Math.ceil(remainingMs / 1000 / 60);

        console.warn(`🚨 IP bloqueada: ${ip} (${remainingMin} min restantes)`);

        return res.status(429).json({
          error: `Acceso bloqueado. Intenta de nuevo en ${remainingMin} minutos.`,
          retry_after: Math.ceil(remainingMs / 1000),
          blocked_until: new Date(blockExpires).toISOString()
        });
      }

      // Incrementar contador de intentos
      const attempts = await redis.incr(ipKey);

      if (attempts === 1) {
        // Primera vez, establecer expiración
        await redis.expire(ipKey, Math.ceil(RATE_LIMIT_CONFIG.WINDOW_MS / 1000));
      }

      // Registrar intento fallido para análisis posterior
      await redis.lpush(logKey, {
        timestamp: now,
        userAgent: req.headers['user-agent'] || 'unknown'
      });
      await redis.expire(logKey, 3600); // Guardar 1 hora de logs

      // Detectar patrón de ataque (subnet)
      const subnetAttempts = await redis.incr(attackKey);
      if (subnetAttempts === 1) {
        await redis.expire(attackKey, Math.ceil(RATE_LIMIT_CONFIG.ATTACK_DETECTION.SUBNET_ATTACK_WINDOW_MS / 1000));
      }

      // Si se excede umbral de intentos, bloquear
      if (attempts > RATE_LIMIT_CONFIG.MAX_ATTEMPTS) {
        const blockUntil = now + RATE_LIMIT_CONFIG.BLOCK_DURATION_MS;
        await redis.setex(ipBlockKey, Math.ceil(RATE_LIMIT_CONFIG.BLOCK_DURATION_MS / 1000), blockUntil.toString());

        console.warn(`🚨 IP BLOQUEADA (demasiados intentos): ${ip}`);

        return res.status(429).json({
          error: `Demasiados intentos fallidos. Cuenta bloqueada por ${Math.ceil(RATE_LIMIT_CONFIG.BLOCK_DURATION_MS / 1000 / 60)} minutos.`,
          retry_after: RATE_LIMIT_CONFIG.BLOCK_DURATION_MS / 1000,
          blocked_until: new Date(blockUntil).toISOString()
        });
      }

      // Advertencia si estamos cerca del límite
      if (attempts > RATE_LIMIT_CONFIG.MAX_ATTEMPTS - 3) {
        console.warn(`⚠️ IP cerca del límite: ${ip} (${attempts}/${RATE_LIMIT_CONFIG.MAX_ATTEMPTS} intentos)`);
      }

      // Detectar patrón de ataque en subnet
      if (subnetAttempts > RATE_LIMIT_CONFIG.ATTACK_DETECTION.SUBNET_ATTACK_THRESHOLD) {
        console.error(`🚨 ATAQUE DETECTADO - Rango IP: ${subnet} (${subnetAttempts} intentos)`);
        // Aquí podrías alertar a un admin o escalar a Cloudflare
      }

      // Pasar datos al siguiente middleware
      req.rateLimit = {
        ip,
        attempts,
        remaining: RATE_LIMIT_CONFIG.MAX_ATTEMPTS - attempts,
        resetAt: new Date(now + RATE_LIMIT_CONFIG.WINDOW_MS).toISOString()
      };
    }

    next();
  } catch (error) {
    console.error('Error en rate limiting:', error);
    // Pasar al siguiente middleware en caso de error (no bloquear)
    next();
  }
};

// Resetear intentos tras login exitoso
export const resetLoginAttempts = async (req) => {
  try {
    if (!redis) return;

    const ip = getClientIP(req);
    const ipKey = `login:attempts:${ip}`;
    const ipBlockKey = `login:blocked:${ip}`;

    await redis.del(ipKey);
    await redis.del(ipBlockKey);

    console.log(`✅ Contador de intentos resetado para IP: ${ip}`);
  } catch (error) {
    console.error('Error reseteando intentos:', error);
  }
};

// Obtener estadísticas de rate limit (para admin)
export const getRateLimitStats = async (req, res) => {
  try {
    if (!redis) {
      return res.status(503).json({ error: 'Redis no está disponible' });
    }

    // Requireroot auth
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Solo admin puede ver estadísticas' });
    }

    const ip = getClientIP(req);
    const ipKey = `login:attempts:${ip}`;
    const logKey = `login:log:${ip}`;

    const attempts = await redis.get(ipKey) || 0;
    const logs = await redis.lrange(logKey, 0, -1);

    res.json({
      ip,
      current_attempts: attempts,
      max_attempts: RATE_LIMIT_CONFIG.MAX_ATTEMPTS,
      remaining: Math.max(0, RATE_LIMIT_CONFIG.MAX_ATTEMPTS - attempts),
      window_minutes: RATE_LIMIT_CONFIG.WINDOW_MS / 1000 / 60,
      recent_logs: logs
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: error.message });
  }
};

export default { initializeRedis, loginRateLimitRedis, resetLoginAttempts, getRateLimitStats };
