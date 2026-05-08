const { google } = require('@googleapis/drive')
const fs = require('fs')
const path = require('path')

const TODAY = new Date().toISOString().slice(0, 10)
const BACKUP_DIR = `/tmp/abzend-backup-${TODAY}`

const TABLES = [
  'orders', 'users', 'drivers', 'clientes', 'transport_orders',
  'transport_order_stops', 'transport_units', 'transport_rates',
  'order_events', 'proof_of_delivery', 'ratings', 'driver_locations',
  'shipment_statuses', 'cliente_direcciones', 'cliente_contactos', 'cliente_documentos'
]

async function fetchTable(table) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*`
  console.log(`URL: ${url}`)
  console.log(`KEY length: ${process.env.SUPABASE_SERVICE_ROLE_KEY?.length}`)
  console.log(`KEY starts: ${process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0,20)}`)
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'count=exact'
    }
  })
  if (!res.ok) throw new Error(`Error en tabla ${table}: ${res.status} ${res.statusText}`)
  return res.json()
}

async function backupDatabase() {
  const dbDir = `${BACKUP_DIR}/database`
  fs.mkdirSync(dbDir, { recursive: true })

  let summary = `-- ABZEND Database Backup ${TODAY}\n-- Generado: ${new Date().toISOString()}\n\n`
  let totalRows = 0

  for (const table of TABLES) {
    try {
      const rows = await fetchTable(table)
      const count = Array.isArray(rows) ? rows.length : 0
      totalRows += count
      fs.writeFileSync(`${dbDir}/${table}.json`, JSON.stringify(rows, null, 2))
      summary += `-- ${table}: ${count} registros\n`
      console.log(`  ${table}: ${count} registros`)
    } catch (e) {
      summary += `-- ${table}: ERROR - ${e.message}\n`
      console.log(`  ${table}: ERROR - ${e.message}`)
    }
  }

  summary += `\n-- Total registros: ${totalRows}\n`
  fs.writeFileSync(`${dbDir}/_resumen.txt`, summary)
  console.log(`Database backup completado: ${totalRows} registros totales`)
}

async function backupStorage() {
  const storageDir = `${BACKUP_DIR}/storage`
  fs.mkdirSync(storageDir, { recursive: true })

  const buckets = ['clientes-docs']
  for (const bucket of buckets) {
    try {
      const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket/${bucket}`, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      })
      const listRes = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ limit: 1000, offset: 0 })
      })
      const files = await listRes.json()
      const manifest = { bucket, date: TODAY, files: Array.isArray(files) ? files.map(f => f.name) : [] }
      fs.writeFileSync(`${storageDir}/${bucket}-manifest.json`, JSON.stringify(manifest, null, 2))
      console.log(`Storage ${bucket}: ${manifest.files.length} archivos registrados`)
    } catch (e) {
      console.log(`Storage ${bucket}: ERROR - ${e.message}`)
    }
  }
}

async function uploadToDrive() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive']
  })
  const drive = google.drive({ version: 'v3', auth })

  const folderRes = await drive.files.create({
    requestBody: {
      name: TODAY,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
    }
  })
  const dayFolderId = folderRes.data.id

  const files = getAllFiles(BACKUP_DIR)
  for (const filePath of files) {
    const fileName = path.relative(BACKUP_DIR, filePath).replace(/[\/\\]/g, '_')
    await drive.files.create({
      requestBody: { name: fileName, parents: [dayFolderId] },
      media: { body: fs.createReadStream(filePath) }
    })
    console.log(`  Subido: ${fileName}`)
  }

  await cleanOldBackups(drive)
  return files.length
}

function getAllFiles(dir) {
  const files = []
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item)
    if (fs.statSync(full).isDirectory()) files.push(...getAllFiles(full))
    else files.push(full)
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
  for (const folder of (res.data.files || [])) {
    if (new Date(folder.createdTime) < cutoff) {
      await drive.files.delete({ fileId: folder.id })
      console.log(`Eliminado backup antiguo: ${folder.name}`)
    }
  }
}

async function main() {
  console.log(`Iniciando backup ABZEND - ${TODAY}`)
  fs.mkdirSync(BACKUP_DIR, { recursive: true })

  console.log('1. Backup base de datos...')
  await backupDatabase()

  console.log('2. Backup Storage...')
  await backupStorage()

  console.log('3. Subiendo a Google Drive...')
  const filesCount = await uploadToDrive()

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `date=${TODAY}\nfiles_count=${filesCount}\n`)
  }

  console.log(`Backup completado exitosamente. ${filesCount} archivos subidos a Drive.`)
}

main().catch(e => {
  console.error('Error fatal en backup:', e.message)
  process.exit(1)
})