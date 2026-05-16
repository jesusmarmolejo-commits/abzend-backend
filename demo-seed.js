/**
 * ABZEND — Demo Seed Script (corregido para schema real)
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ── Usuarios demo ────────────────────────────────────────────────
const DEMO_USERS = [
  { email: 'demo@abzend.com',    password: 'demo1234',    role: 'client', full_name: 'Cliente Demo',    phone: '+52 55 1234 5678' },
  { email: 'admin@abzend.com',   password: 'admin1234',   role: 'admin',  full_name: 'Admin ABZEND',    phone: '+52 55 9999 0001' },
  { email: 'driver@abzend.com',  password: 'driver1234',  role: 'driver', full_name: 'Carlos Repartidor', phone: '+52 55 9999 0002' },
  { email: 'driver2@abzend.com', password: 'driver1234',  role: 'driver', full_name: 'Laura Mensajera', phone: '+52 55 9999 0003' },
  { email: 'station@abzend.com', password: 'station1234', role: 'client', full_name: 'Bodega Central',  phone: '+52 55 9999 0004' },
];

// ── Órdenes demo ─────────────────────────────────────────────────
const DEMO_ORDERS = [
  { tracking_code:'AB-2041', status:'in_transit',  sender_name:'Tienda Nike',         sender_phone:'+5255111', origin_address:'Insurgentes Sur 1234, CDMX',     recipient_name:'María García',    recipient_phone:'+5255222', dest_address:'Av. Coyoacán 456, CDMX',      subtotal:250, total:250, payment_status:'paid'   },
  { tracking_code:'AB-2042', status:'pending',     sender_name:'Farmacia Guadalajara', sender_phone:'+5255333', origin_address:'Av. Juárez 850, CDMX',          recipient_name:'Roberto Sánchez', recipient_phone:'+5255444', dest_address:'Polanco 234, CDMX',           subtotal:85,  total:85,  payment_status:'pending' },
  { tracking_code:'AB-2040', status:'delivered',   sender_name:'Liverpool Perisur',    sender_phone:'+5255555', origin_address:'Periférico Sur 4690, CDMX',     recipient_name:'Ana López',       recipient_phone:'+5255666', dest_address:'Tlalpan 1500, CDMX',          subtotal:120, total:120, payment_status:'paid'   },
  { tracking_code:'AB-2039', status:'picked_up',   sender_name:'Zara Polanco',         sender_phone:'+5255777', origin_address:'Presidente Masaryk 111, CDMX',  recipient_name:'Diego Fernández', recipient_phone:'+5255888', dest_address:'Condesa 78, CDMX',            subtotal:320, total:320, payment_status:'paid'   },
  { tracking_code:'AB-2038', status:'delivered',   sender_name:'Vips Viaducto',        sender_phone:'+5255999', origin_address:'Viaducto Miguel Alemán 234, CDMX', recipient_name:'Sofía Martínez', recipient_phone:'+5255000', dest_address:'Mixcoac 890, CDMX',        subtotal:65,  total:65,  payment_status:'paid'   },
  { tracking_code:'AB-2037', status:'cancelled',   sender_name:'Sanborns Centro',      sender_phone:'+5255121', origin_address:'Eje Central 567, CDMX',         recipient_name:'Pedro Ramírez',   recipient_phone:'+5255343', dest_address:'Reforma 100, CDMX',           subtotal:180, total:180, payment_status:'refunded'},
];

async function run() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║      ABZEND — Demo Data Seeder         ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Verificar conexión con tabla real del schema
  const { error: pingError } = await supabase.from('users').select('id').limit(1);
  if (pingError && pingError.code !== 'PGRST116') {
    console.error('❌ Error conectando a Supabase:', pingError.message);
    process.exit(1);
  }
  console.log('✅ Conexión a Supabase OK\n');

  // Limpiar si se pide
  if (process.argv.includes('--clean')) {
    console.log('🧹 Limpiando datos demo...');
    await supabase.from('order_events').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('drivers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    console.log('✅ Limpieza completa\n');
  }

  // ── Crear usuarios ──────────────────────────────────────────────
  console.log('👥 Creando usuarios demo...');
  const userIds = {};

  for (const u of DEMO_USERS) {
    // Crear en Auth
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true,
    });

    let authId;
    if (authErr) {
      if (authErr.message.includes('already been registered') || authErr.message.includes('already exists')) {
        // Obtener el existente
        const { data: list } = await supabase.auth.admin.listUsers();
        const found = list?.users?.find(x => x.email === u.email);
        authId = found?.id;
        console.log(`  ⚠️  ${u.email} ya existe`);
      } else {
        console.log(`  ❌ Auth error ${u.email}: ${authErr.message}`);
        continue;
      }
    } else {
      authId = authData.user.id;
    }

    // Insertar en tabla users
    const { data: userData, error: userErr } = await supabase.from('users').upsert({
      auth_id:    authId,
      email:      u.email,
      full_name:  u.full_name,
      phone:      u.phone,
      role:       u.role,
    }, { onConflict: 'email' }).select('id').single();

    if (userErr) {
      console.log(`  ❌ users error ${u.email}: ${userErr.message}`);
      continue;
    }

    userIds[u.email] = userData.id;

    // Si es repartidor, crear registro en drivers
    if (u.role === 'driver') {
      const { data: drvData, error: drvErr } = await supabase.from('drivers').upsert({
        user_id:       userData.id,
        vehicle_type:  u.email.includes('driver2') ? 'bicycle' : 'motorcycle',
        license_plate: u.email.includes('driver2') ? null : 'ABC-123-MX',
        status:        'online',
        rating:        4.8,
      }, { onConflict: 'user_id' }).select('id').single();

      if (!drvErr) {
        userIds[`driver_${u.email}`] = drvData.id;
      }
    }

    console.log(`  ✅ ${u.role.padEnd(8)} → ${u.email}`);
  }

  // ── Crear órdenes ───────────────────────────────────────────────
  console.log('\n📦 Creando órdenes de demo...');

  const clientId  = userIds['demo@abzend.com'];
  const driverId  = userIds['driver_driver@abzend.com'];

  for (const o of DEMO_ORDERS) {
    const orderData = {
      ...o,
      client_id:   clientId  || null,
      driver_id:   ['in_transit','picked_up','delivered'].includes(o.status) ? (driverId || null) : null,
      origin_lat:  19.4200 + (Math.random() - 0.5) * 0.1,
      origin_lng:  -99.1700 + (Math.random() - 0.5) * 0.1,
      dest_lat:    19.4200 + (Math.random() - 0.5) * 0.1,
      dest_lng:    -99.1700 + (Math.random() - 0.5) * 0.1,
      is_demo:     true,
      created_at:  new Date(Date.now() - Math.random() * 86400000 * 3).toISOString(),
    };

    const { error: ordErr } = await supabase.from('orders')
      .upsert(orderData, { onConflict: 'tracking_code' });

    if (ordErr) console.log(`  ❌ ${o.tracking_code}: ${ordErr.message}`);
    else        console.log(`  ✅ ${o.tracking_code.padEnd(10)} → ${o.status}`);
  }

  // ── GPS del repartidor ──────────────────────────────────────────
  if (driverId) {
    console.log('\n📍 Actualizando GPS del repartidor...');
    await supabase.from('drivers').update({
      last_lat: 19.3980, last_lng: -99.1700, last_seen_at: new Date().toISOString()
    }).eq('id', driverId);
    console.log('  ✅ GPS actualizado');
  }

  // ── Resumen ─────────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║              ✅ Demo listo para usar                   ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  demo@abzend.com    / demo1234     → Cliente           ║');
  console.log('║  admin@abzend.com   / admin1234    → Admin             ║');
  console.log('║  driver@abzend.com  / driver1234   → Repartidor        ║');
  console.log('║  station@abzend.com / station1234  → Station           ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

run().catch(err => { console.error('❌ Error fatal:', err.message); process.exit(1); });
