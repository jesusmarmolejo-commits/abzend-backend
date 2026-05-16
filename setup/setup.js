#!/usr/bin/env node
/**
 * ABZEND — Script de setup para nueva instancia
 *
 * Uso:
 *   node setup/setup.js              → setup completo interactivo
 *   node setup/setup.js --migrations → solo aplicar migraciones pendientes
 *   node setup/setup.js --storage    → solo crear buckets de Storage
 *   node setup/setup.js --env        → solo generar archivos .env.local
 *
 * Para R2/R3: solo correr `node setup/setup.js --migrations` aplica
 * las migraciones nuevas sin tocar el resto.
 */

const readline = require('readline')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { run: applyMigrations } = require('./apply-migrations')
const { run: setupStorage } = require('./setup-storage')

const ROOT = path.join(__dirname, '..')
const TEMPLATES_DIR = path.join(__dirname, 'templates')
const PROJECTS = [
  { name: 'abzend-panel-admin',      template: 'env.admin.template',      dir: path.join(ROOT, '..', 'abzend-panel-admin') },
  { name: 'abzend-panel-cliente',    template: 'env.cliente.template',    dir: path.join(ROOT, '..', 'abzend-panel-cliente') },
  { name: 'abzend-panel-repartidor', template: 'env.repartidor.template', dir: path.join(ROOT, '..', 'abzend-panel-repartidor') },
  { name: 'abzend-panel-station',    template: 'env.station.template',    dir: path.join(ROOT, '..', 'abzend-panel-station') },
  { name: 'abzend-tracking',         template: 'env.tracking.template',   dir: path.join(ROOT, '..', 'abzend-tracking') },
  { name: 'abzend-backend',          template: 'env.backend.template',    dir: ROOT },
]

// ─── Utilidades ───────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question, defaultVal = '') {
  return new Promise((resolve) => {
    const hint = defaultVal ? ` (default: ${defaultVal})` : ''
    rl.question(`${question}${hint}: `, (ans) => {
      resolve(ans.trim() || defaultVal)
    })
  })
}

function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(`${question}: `)
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    let value = ''
    stdin.on('data', function handler(char) {
      char = char.toString()
      if (char === '\r' || char === '\n') {
        stdin.setRawMode?.(false)
        stdin.removeListener('data', handler)
        process.stdout.write('\n')
        resolve(value)
      } else if (char === '') {
        process.exit()
      } else if (char === '') {
        value = value.slice(0, -1)
      } else {
        value += char
        process.stdout.write('*')
      }
    })
  })
}

function randomSecret(len = 32) {
  return crypto.randomBytes(len).toString('hex')
}

function fillTemplate(templateFile, vars) {
  let content = fs.readFileSync(path.join(TEMPLATES_DIR, templateFile), 'utf8')
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value)
  }
  return content
}

function banner(text) {
  const line = '─'.repeat(50)
  console.log(`\n${line}`)
  console.log(`  ${text}`)
  console.log(`${line}`)
}

// ─── Pasos ────────────────────────────────────────────────────

async function collectCredentials() {
  banner('CREDENCIALES DE SUPABASE')
  console.log('Encuéntralas en: Supabase Dashboard → Settings → API\n')

  const SUPABASE_URL = await ask('URL del proyecto (ej: https://xxxx.supabase.co)')
  const SUPABASE_ANON_KEY = await ask('anon key')
  const SUPABASE_SERVICE_ROLE_KEY = await ask('service_role key')

  banner('CONFIGURACIÓN ADICIONAL')

  const RESEND_API_KEY = await ask('Resend API key (para emails, dejar vacío si no aplica)', '')
  const NOTIFY_WEBHOOK_SECRET = await ask('Webhook secret para /api/notify', randomSecret(24))
  const JWT_SECRET = await ask('JWT secret para el backend', randomSecret(32))
  const ALLOWED_ORIGINS = await ask(
    'Orígenes CORS permitidos (separados por coma)',
    'https://abzend-panel-admin.vercel.app,https://abzend-panel-cliente.vercel.app'
  )
  const STRIPE_SECRET_KEY = await ask('Stripe secret key (dejar vacío si no aplica)', '')
  const STRIPE_WEBHOOK_SECRET = await ask('Stripe webhook secret (dejar vacío si no aplica)', '')
  const ADMIN_SECRET = await ask('Admin secret del backend', randomSecret(20))

  return {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY,
    NOTIFY_WEBHOOK_SECRET,
    JWT_SECRET,
    ALLOWED_ORIGINS,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    ADMIN_SECRET,
  }
}

async function generateEnvFiles(vars) {
  banner('GENERANDO ARCHIVOS .env.local')

  for (const project of PROJECTS) {
    const envPath = path.join(project.dir, '.env.local')
    const content = fillTemplate(project.template, vars)

    if (!fs.existsSync(project.dir)) {
      console.log(`  ⚠️  Directorio no encontrado: ${project.name} — omitido`)
      continue
    }

    const exists = fs.existsSync(envPath)
    if (exists) {
      const backup = `${envPath}.backup-${Date.now()}`
      fs.copyFileSync(envPath, backup)
      console.log(`  📋 ${project.name}/.env.local actualizado (backup en ${path.basename(backup)})`)
    } else {
      console.log(`  ✅ ${project.name}/.env.local creado`)
    }

    fs.writeFileSync(envPath, content)
  }

  // También genera un archivo resumen con todos los valores para configurar Vercel/GitHub
  const summary = [
    '# ABZEND — Variables de entorno generadas',
    `# Fecha: ${new Date().toISOString()}`,
    '# IMPORTANTE: No subir este archivo a git',
    '',
    '## Supabase',
    `SUPABASE_URL=${vars.SUPABASE_URL}`,
    `SUPABASE_ANON_KEY=${vars.SUPABASE_ANON_KEY}`,
    `SUPABASE_SERVICE_ROLE_KEY=${vars.SUPABASE_SERVICE_ROLE_KEY}`,
    '',
    '## Panel Admin',
    `NOTIFY_WEBHOOK_SECRET=${vars.NOTIFY_WEBHOOK_SECRET}`,
    `RESEND_API_KEY=${vars.RESEND_API_KEY}`,
    '',
    '## Backend',
    `JWT_SECRET=${vars.JWT_SECRET}`,
    `ALLOWED_ORIGINS=${vars.ALLOWED_ORIGINS}`,
    `ADMIN_SECRET=${vars.ADMIN_SECRET}`,
    vars.STRIPE_SECRET_KEY ? `STRIPE_SECRET_KEY=${vars.STRIPE_SECRET_KEY}` : '',
    vars.STRIPE_WEBHOOK_SECRET ? `STRIPE_WEBHOOK_SECRET=${vars.STRIPE_WEBHOOK_SECRET}` : '',
    '',
    '## GitHub Secrets para backup (los de Google Drive se configuran por separado)',
    `SUPABASE_URL=${vars.SUPABASE_URL}`,
    `SUPABASE_SERVICE_ROLE_KEY=${vars.SUPABASE_SERVICE_ROLE_KEY}`,
  ].filter((l) => l !== undefined).join('\n')

  const summaryPath = path.join(__dirname, 'credentials-summary.txt')
  fs.writeFileSync(summaryPath, summary)
  console.log(`\n  📄 Resumen guardado en setup/credentials-summary.txt`)
  console.log('  ⚠️  IMPORTANTE: No subas ese archivo a git. Elimínalo después de configurar Vercel.')
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const onlyMigrations = args.includes('--migrations')
  const onlyStorage = args.includes('--storage')
  const onlyEnv = args.includes('--env')

  console.log('\n╔══════════════════════════════════╗')
  console.log('║      ABZEND — Setup Script       ║')
  console.log('╚══════════════════════════════════╝')

  // Modo: solo migraciones (para R2, R3, etc.)
  if (onlyMigrations) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      console.error('\nFaltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY como variables de entorno.')
      console.error('Ejemplo: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxx node setup/setup.js --migrations')
      process.exit(1)
    }
    await applyMigrations(url, key)
    console.log('\n✅ Migraciones completadas.')
    rl.close()
    return
  }

  // Modo: solo storage
  if (onlyStorage) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      console.error('\nFaltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
      process.exit(1)
    }
    await setupStorage(url, key)
    console.log('\n✅ Storage configurado.')
    rl.close()
    return
  }

  // Setup completo o solo env
  const vars = await collectCredentials()

  if (!onlyEnv) {
    await applyMigrations(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY)
    await setupStorage(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY)
  }

  await generateEnvFiles(vars)

  banner('PRÓXIMOS PASOS')
  console.log(`
  1. Vercel — configura las variables de entorno en cada proyecto
     usando los valores de setup/credentials-summary.txt

  2. GitHub Secrets — actualiza en abzend-backend:
     SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY

  3. Supabase Auth — habilita Google OAuth:
     Authentication → Providers → Google
     (necesitas las mismas credenciales OAuth2 de Google Cloud)

  4. Supabase Realtime — activa las tablas:
     Database → Replication → Tables
     Activa: orders, driver_locations, order_events

  5. Elimina setup/credentials-summary.txt después de configurar todo

  Para aplicar migraciones futuras (R2, R3):
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node setup/setup.js --migrations
`)

  rl.close()
  console.log('✅ Setup completado.\n')
}

main().catch((e) => {
  console.error('\n❌ Error:', e.message)
  rl.close()
  process.exit(1)
})
