const { google } = require('@googleapis/drive')
const { Client } = require('pg')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const TODAY = new Date().toISOString().slice(0, 10)
const BACKUP_DIR = `/tmp/abzend-backup-${TODAY}`

async function main() {
  console.log(`Iniciando backup ABZEND - ${TODAY}`)
  fs.mkdirSync(BACKUP_DIR, { recursive: true })

  // 1. Backup PostgreSQL via Supabase
  console.log('Haciendo dump de base de datos...')
  await backupDatabase()

  // 2. Backup Supabase Storage
  console.log('Descargando archivos de Storage...')
  await backupStorage()

  // 3. Subir a Google Drive
  console.log('Subiendo a Google Drive...')
  const filesCount = await uploadToDrive()

  // Output para GitHub Actions
  fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/null',
    `date=${TODAY}\nfiles_count=${filesCount}\n`)

  console.log(`Backup completado. ${filesCount} archivos subidos.`)
}

async function backupDatabase() {
  const url = new URL(process.env.SUPABASE_URL)
  const host = url.hostname
  const dbUrl = `postgresql://postgres:${process.env.SUPABASE_SERVICE_ROLE_KEY}@${host}:5432/postgres`

  try {
    execSync(`pg_dump "${dbUrl}" > ${BACKUP_DIR}/database.sql`, {
      env: { ...process.env, PGPASSWORD: process.env.SUPABASE_SERVICE_ROLE_KEY }
    })
    console.log('Database dump completado')
  } catch (e) {
    // Si pg_dump no está disponible, hacemos backup via API
    console.log('pg_dump no disponible, usando API...')
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    const tables = ['orders', 'users', 'drivers', 'clientes', 'transport_orders',
      'transport_order_stops', 'transport_units', 'transport_rates',
      'order_events', 'proof_of_delivery', 'ratings', 'driver_locations',
      'shipment_statuses', 'cliente_direcciones', 'cliente_contactos', 'cliente_documentos']
    let dump = `-- ABZEND Database Backup ${TODAY}\n\n`
    for (const table of tables) {
      try {
        const res = await client.query(`SELECT * FROM ${table}`)
        dump += `-- Table: ${table} (${res.rows.length} rows)\n`
        dump += JSON.stringify(res.rows, null, 2) + '\n\n'
      } catch (err) {
        dump += `-- Table ${table}: ERROR ${err.message}\n\n`
      }
    }
    fs.writeFileSync(`${BACKUP_DIR}/database.sql`, dump)
    await client.end()
  }
}

async function backupStorage() {
  const storageDir = `${BACKUP_DIR}/storage`
  fs.mkdirSync(storageDir, { recursive: true })

  const buckets = ['clientes-docs']
  for (const bucket of buckets) {
    const url = `${process.env.SUPABASE_URL}/storage/v1/object/list/${bucket}`
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
      })
      const files = await res.json()
      if (Array.isArray(files)) {
        const meta = { bucket, files: files.map(f => f.name), date: TODAY }
        fs.writeFileSync(`${storageDir}/${bucket}-manifest.json`, JSON.stringify(meta, null, 2))
        console.log(`Storage bucket ${bucket}: ${files.length} archivos registrados`)
      }
    } catch (e) {
      console.log(`Error en storage bucket ${bucket}: ${e.message}`)
    }
  }
}

async function uploadToDrive() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive']
  })
  const drive = google.drive({ version: 'v3', auth })

  // Crear carpeta del dia
  const folderRes = await drive.files.create({
    requestBody: {
      name: TODAY,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
    }
  })
  const dayFolderId = folderRes.data.id

  // Subir todos los archivos
  const files = getAllFiles(BACKUP_DIR)
  for (const filePath of files) {
    const fileName = path.relative(BACKUP_DIR, filePath).replace(/\//g, '_')
    await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [dayFolderId]
      },
      media: {
        body: fs.createReadStream(filePath)
      }
    })
    console.log(`Subido: ${fileName}`)
  }

  // Limpiar backups viejos (mas de 30 dias)
  await cleanOldBackups(drive)

  return files.length
}

function getAllFiles(dir) {
  const files = []
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item)
    if (fs.statSync(full).isDirectory()) {
      files.push(...getAllFiles(full))
    } else {
      files.push(full)
    }
  }
  return files
}

async function cleanOldBackups(drive) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const res = await drive.files.list({
    q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder'`,
    fields: 'files(id, name, createdTime)'
  })
  for (const folder of res.data.files || []) {
    if (new Date(folder.createdTime) < cutoff) {
      await drive.files.delete({ fileId: folder.id })
      console.log(`Eliminado backup antiguo: ${folder.name}`)
    }
  }
}

main().catch(e => {
  console.error('Error en backup:', e.message)
  process.exit(1)
})