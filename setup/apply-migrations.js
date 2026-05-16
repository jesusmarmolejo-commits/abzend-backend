/**
 * Aplica las migraciones pendientes a un proyecto Supabase.
 * Detecta automáticamente cuáles ya fueron aplicadas y solo ejecuta las nuevas.
 *
 * Uso: node setup/apply-migrations.js
 * Variables requeridas: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
const fs = require('fs')
const path = require('path')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations')

async function sql(url, key, query) {
  const res = await fetch(`${url}/rest/v1/rpc/`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })
  // Usamos el endpoint de SQL directo vía REST
  return res
}

async function execSQL(url, key, sqlText) {
  const res = await fetch(`${url}/rest/v1/`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Client-Info': 'abzend-setup',
    },
  })
  // Supabase no expone un endpoint REST genérico de SQL — usamos el de postgres directamente
  // vía el Management API o el SQL Editor. Para scripts de setup usamos fetch al endpoint correcto.
  return res
}

async function runSQL(url, key, sqlText) {
  // Usamos el endpoint de SQL de Supabase (disponible con service_role)
  const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql: sqlText }),
  })

  if (!res.ok) {
    // Fallback: intentar con el endpoint de postgres directo
    const res2 = await fetch(`${url}/pg`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sqlText }),
    })
    return res2
  }
  return res
}

async function getAppliedMigrations(url, key) {
  const res = await fetch(
    `${url}/rest/v1/schema_migrations?select=version&order=version.asc`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    }
  )
  if (!res.ok) return new Set() // tabla aún no existe
  const rows = await res.json()
  return new Set((rows || []).map((r) => r.version))
}

async function applyMigration(url, key, file, version) {
  const sqlText = fs.readFileSync(file, 'utf8')
  console.log(`  Aplicando ${version}...`)

  const res = await fetch(`${url}/rest/v1/rpc/exec_migration`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql_text: sqlText }),
  })

  // Si el RPC no existe, indicamos al usuario que use el SQL Editor manualmente
  if (res.status === 404 || res.status === 405) {
    return { manual: true, sql: sqlText }
  }

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Error en migración ${version}: ${body}`)
  }

  return { manual: false }
}

async function run(url, key) {
  console.log('\n📦 Verificando migraciones pendientes...')

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const applied = await getAppliedMigrations(url, key)
  const pending = migrationFiles.filter((f) => {
    const version = f.split('_')[0]
    return !applied.has(version)
  })

  if (pending.length === 0) {
    console.log('  ✅ Todas las migraciones ya están aplicadas.')
    return
  }

  console.log(`  ${pending.length} migración(es) pendiente(s):`)
  pending.forEach((f) => console.log(`    - ${f}`))
  console.log('')

  const manualSQL = []

  for (const file of pending) {
    const version = file.split('_')[0]
    const filePath = path.join(MIGRATIONS_DIR, file)
    try {
      const result = await applyMigration(url, key, filePath, version)
      if (result.manual) {
        manualSQL.push({ version, file, sql: result.sql })
        console.log(`  ⚠️  ${version} requiere aplicación manual (ver instrucciones abajo)`)
      } else {
        console.log(`  ✅ ${version} aplicada`)
      }
    } catch (e) {
      console.error(`  ❌ Error en ${version}: ${e.message}`)
      throw e
    }
  }

  if (manualSQL.length > 0) {
    console.log('\n──────────────────────────────────────────────')
    console.log('MIGRACIONES PARA APLICAR MANUALMENTE')
    console.log('Copia cada bloque SQL en Supabase Dashboard → SQL Editor → Run')
    console.log('──────────────────────────────────────────────')
    for (const { version, file, sql } of manualSQL) {
      console.log(`\n-- Migración ${version} (${file})\n`)
      console.log(sql)
      console.log('\n──────────────────────────────────────────────')
    }

    // También genera archivos de salida para copiar fácilmente
    const outDir = path.join(__dirname, '..', 'setup', 'pending-sql')
    fs.mkdirSync(outDir, { recursive: true })
    for (const { file, sql } of manualSQL) {
      fs.writeFileSync(path.join(outDir, file), sql)
    }
    console.log(`\nArchivos SQL guardados en: setup/pending-sql/`)
  }
}

module.exports = { run }

if (require.main === module) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  run(url, key).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
