/**
 * Crea los buckets de Supabase Storage necesarios para ABZEND.
 * Idempotente: no falla si el bucket ya existe.
 */

const BUCKETS = [
  {
    id: 'clientes-docs',
    name: 'clientes-docs',
    public: false,
    fileSizeLimit: 10485760, // 10 MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  },
  {
    id: 'avatars',
    name: 'avatars',
    public: true,
    fileSizeLimit: 2097152, // 2 MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  {
    id: 'proof-of-delivery',
    name: 'proof-of-delivery',
    public: false,
    fileSizeLimit: 10485760,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
]

async function createBucket(url, key, bucket) {
  const res = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: bucket.id,
      name: bucket.name,
      public: bucket.public,
      file_size_limit: bucket.fileSizeLimit,
      allowed_mime_types: bucket.allowedMimeTypes,
    }),
  })

  if (res.status === 409) {
    // Ya existe
    return 'exists'
  }

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Error creando bucket ${bucket.id}: ${body}`)
  }

  return 'created'
}

async function run(url, key) {
  console.log('\n🗂️  Configurando Storage buckets...')

  for (const bucket of BUCKETS) {
    const result = await createBucket(url, key, bucket)
    if (result === 'exists') {
      console.log(`  ⏭️  ${bucket.id} ya existe`)
    } else {
      console.log(`  ✅ ${bucket.id} creado (público: ${bucket.public})`)
    }
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
