/**
 * ABZEND — Demo Seed Script
 * ─────────────────────────────────────────────────────────────────
 * Crea usuarios demo, órdenes de muestra y datos de repartidores
 * en tu proyecto Supabase para que clientes potenciales puedan
 * probar la plataforma con datos realistas.
 *
 * USO:
 *   1. Copia este archivo a la raíz de abzend-backend
 *   2. Crea un archivo .env con tus credenciales (o asegúrate de tenerlas)
 *   3. Ejecuta: node demo-seed.js
 *   4. Comparte las credenciales demo con tus clientes
 *
 * CUENTAS CREADAS:
 *   - demo@abzend.com        / demo1234    → rol: cliente
 *   - admin@abzend.com       / admin1234   → rol: admin
 *   - driver@abzend.com      / driver1234  → rol: repartidor
 *   - station@abzend.com     / station1234 → rol: station
 * ─────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // necesita service_role para admin actions
);

// ─── DATOS DEMO ───────────────────────────────────────────────────

const DEMO_USERS = [
  {
    email: 'demo@abzend.com',
    password: 'demo1234',
    role: 'cliente',
    full_name: 'Cliente Demo',
    phone: '+52 55 1234 5678'
  },
  {
    email: 'admin@abzend.com',
    password: 'admin1234',
    role: 'admin',
    full_name: 'Admin ABZEND',
    phone: '+52 55 9999 0001'
  },
  {
    email: 'driver@abzend.com',
    password: 'driver1234',
    role: 'repartidor',
    full_name: 'Carlos Repartidor',
    phone: '+52 55 9999 0002',
    vehicle: 'motocicleta',
    plate: 'ABC-123'
  },
  {
    email: 'driver2@abzend.com',
    password: 'driver1234',
    role: 'repartidor',
    full_name: 'Laura Mensajera',
    phone: '+52 55 9999 0003',
    vehicle: 'bicicleta',
    plate: null
  },
  {
    email: 'station@abzend.com',
    password: 'station1234',
    role: 'station',
    full_name: 'Bodega Central',
    phone: '+52 55 9999 0004'
  }
];

const DEMO_ORDERS = [
  {
    reference: 'ABZ-2041',
    status: 'en_camino',
    customer_name: 'María García',
    customer_phone: '+52 55 1111 2222',
    pickup_address: 'Insurgentes Sur 1234, Col. Del Valle, CDMX',
    delivery_address: 'Av. Coyoacán 456, Col. Narvarte, CDMX',
    description: 'Paquete electrónico — 2kg — frágil',
    amount: 250.00,
    payment_status: 'pagado',
    driver_name: 'Carlos Repartidor',
    lat_pickup: 19.3667, lng_pickup: -99.1720,
    lat_delivery: 19.4078, lng_delivery: -99.1677,
  },
  {
    reference: 'ABZ-2042',
    status: 'pendiente',
    customer_name: 'Roberto Sánchez',
    customer_phone: '+52 55 3333 4444',
    pickup_address: 'Av. Juárez 850, Centro Histórico, CDMX',
    delivery_address: 'Polanco 234, Col. Polanco, CDMX',
    description: 'Documento urgente — sobre',
    amount: 85.00,
    payment_status: 'pendiente',
    driver_name: null,
    lat_pickup: 19.4360, lng_pickup: -99.1419,
    lat_delivery: 19.4319, lng_delivery: -99.1958,
  },
  {
    reference: 'ABZ-2040',
    status: 'entregado',
    customer_name: 'Ana López',
    customer_phone: '+52 55 5555 6666',
    pickup_address: 'Periférico Sur 4690, Perisur, CDMX',
    delivery_address: 'Tlalpan 1500, Col. Tlalpan, CDMX',
    description: 'Ropa — bolsa mediana — 1.5kg',
    amount: 120.00,
    payment_status: 'pagado',
    driver_name: 'Laura Mensajera',
    lat_pickup: 19.3087, lng_pickup: -99.1878,
    lat_delivery: 19.2922, lng_delivery: -99.1548,
  },
  {
    reference: 'ABZ-2039',
    status: 'recogido',
    customer_name: 'Diego Fernández',
    customer_phone: '+52 55 7777 8888',
    pickup_address: 'Presidente Masaryk 111, Polanco, CDMX',
    delivery_address: 'Condesa 78, Col. Condesa, CDMX',
    description: 'Accesorios de moda — caja pequeña',
    amount: 320.00,
    payment_status: 'pagado',
    driver_name: 'Carlos Repartidor',
    lat_pickup: 19.4319, lng_pickup: -99.1958,
    lat_delivery: 19.4126, lng_delivery: -99.1721,
  },
  {
    reference: 'ABZ-2038',
    status: 'entregado',
    customer_name: 'Sofía Martínez',
    customer_phone: '+52 55 9999 0000',
    pickup_address: 'Viaducto Miguel Alemán 234, CDMX',
    delivery_address: 'Mixcoac 890, Col. Mixcoac, CDMX',
    description: 'Alimentos — bolsa térmica — urgente',
    amount: 65.00,
    payment_status: 'pagado',
    driver_name: 'Carlos Repartidor',
    lat_pickup: 19.4025, lng_pickup: -99.1600,
    lat_delivery: 19.3829, lng_delivery: -99.1921,
  },
  {
    reference: 'ABZ-2037',
    status: 'cancelado',
    customer_name: 'Pedro Ramírez',
    customer_phone: '+52 55 1212 3434',
    pickup_address: 'Eje Central 567, Col. Doctores, CDMX',
    delivery_address: 'Reforma 100, Col. Cuauhtémoc, CDMX',
    description: 'Medicamentos — caja mediana',
    amount: 180.00,
    payment_status: 'reembolsado',
    driver_name: null,
    lat_pickup: 19.4190, lng_pickup: -99.1408,
    lat_delivery: 19.4270, lng_delivery: -99.1679,
  }
];

// ─── FUNCIONES ────────────────────────────────────────────────────

async function createDemoUsers() {
  console.log('\n👥 Creando usuarios demo...');
  const createdUsers = {};

  for (const user of DEMO_USERS) {
    try {
      // Crear en Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: user.email,
        password: user.password,
        email_confirm: true,
        user_metadata: {
          full_name: user.full_name,
          role: user.role
        }
      });

      if (authError) {
        if (authError.message.includes('already registered')) {
          console.log(`  ⚠️  ${user.email} ya existe, omitiendo...`);
          // Obtener el ID del usuario existente
          const { data: existing } = await supabase.auth.admin.listUsers();
          const found = existing?.users?.find(u => u.email === user.email);
          if (found) createdUsers[user.role] = found.id;
          continue;
        }
        throw authError;
      }

      const userId = authData.user.id;
      createdUsers[user.role] = userId;

      // Insertar en tabla profiles
      const profileData = {
        id: userId,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role,
        is_demo: true,
        created_at: new Date().toISOString()
      };

      if (user.role === 'repartidor') {
        profileData.vehicle = user.vehicle;
        profileData.plate = user.plate;
        profileData.is_online = true;
        profileData.rating = (Math.random() * 1 + 4).toFixed(1); // 4.0–5.0
      }

      const { error: profileError } = await supabase
        .from('profiles')
        .upsert(profileData);

      if (profileError) {
        console.log(`  ⚠️  Error en profile de ${user.email}:`, profileError.message);
      } else {
        console.log(`  ✅ ${user.role.padEnd(12)} → ${user.email}`);
      }

    } catch (err) {
      console.error(`  ❌ Error creando ${user.email}:`, err.message);
    }
  }

  return createdUsers;
}

async function createDemoOrders(userIds) {
  console.log('\n📦 Creando órdenes de demo...');

  for (const order of DEMO_ORDERS) {
    try {
      const qrCode = `ABZEND-${order.reference}-${Date.now().toString(36).toUpperCase()}`;

      const orderData = {
        reference: order.reference,
        status: order.status,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        pickup_address: order.pickup_address,
        delivery_address: order.delivery_address,
        description: order.description,
        amount: order.amount,
        payment_status: order.payment_status,
        qr_code: qrCode,
        is_demo: true,
        created_at: new Date(Date.now() - Math.random() * 86400000 * 3).toISOString(), // últimas 72h
        updated_at: new Date().toISOString()
      };

      // Asignar IDs si existen
      if (userIds.cliente) orderData.client_id = userIds.cliente;
      if (order.driver_name && userIds.repartidor) {
        orderData.driver_id = userIds.repartidor;
      }

      const { data, error } = await supabase
        .from('orders')
        .upsert(orderData, { onConflict: 'reference' })
        .select();

      if (error) {
        console.log(`  ⚠️  Error en orden ${order.reference}:`, error.message);
      } else {
        console.log(`  ✅ ${order.reference.padEnd(10)} → ${order.status.padEnd(12)} — ${order.customer_name}`);
      }

    } catch (err) {
      console.error(`  ❌ Error creando orden ${order.reference}:`, err.message);
    }
  }
}

async function createDriverLocations(userIds) {
  console.log('\n📍 Creando ubicaciones GPS de repartidores...');

  const locations = [
    {
      driver_id: userIds.repartidor,
      lat: 19.3980 + (Math.random() - 0.5) * 0.02,
      lng: -99.1700 + (Math.random() - 0.5) * 0.02,
      speed: Math.floor(Math.random() * 40 + 10),
      heading: Math.floor(Math.random() * 360),
      accuracy: 5,
      is_online: true
    }
  ];

  for (const loc of locations) {
    if (!loc.driver_id) continue;

    const { error } = await supabase
      .from('driver_locations')
      .upsert({
        ...loc,
        timestamp: new Date().toISOString()
      }, { onConflict: 'driver_id' });

    if (error) {
      console.log(`  ⚠️  Error en ubicación GPS:`, error.message);
    } else {
      console.log(`  ✅ GPS actualizado — lat:${loc.lat.toFixed(4)}, lng:${loc.lng.toFixed(4)}`);
    }
  }
}

async function cleanDemoData() {
  console.log('\n🧹 Limpiando datos demo anteriores...');

  const { error: ordersError } = await supabase
    .from('orders')
    .delete()
    .eq('is_demo', true);

  if (!ordersError) console.log('  ✅ Órdenes demo eliminadas');
  else console.log('  ⚠️  Error limpiando órdenes (puede que no existan)');
}

// ─── MAIN ─────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║      ABZEND — Demo Data Seeder         ║');
  console.log('╚════════════════════════════════════════╝');

  // Verificar conexión
  const { error: pingError } = await supabase.from('profiles').select('count').limit(1);
  if (pingError && pingError.code !== 'PGRST116') {
    console.error('\n❌ No se pudo conectar a Supabase. Verifica tus variables de entorno:');
    console.error('   SUPABASE_URL:', process.env.SUPABASE_URL ? '✓ configurado' : '✗ FALTA');
    console.error('   SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓ configurado' : '✗ FALTA');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.includes('--clean')) {
    await cleanDemoData();
  }

  // Crear datos
  const userIds = await createDemoUsers();
  await createDemoOrders(userIds);
  await createDriverLocations(userIds);

  // Resumen
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║              ✅ Demo listo para usar                   ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  PANEL CLIENTE:    abzend-panel-cliente.vercel.app     ║');
  console.log('║  PANEL ADMIN:      abzend-panel-admin.vercel.app       ║');
  console.log('║  PANEL REPARTIDOR: abzend-panel-repartidor.vercel.app  ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  demo@abzend.com    / demo1234     → Cliente           ║');
  console.log('║  admin@abzend.com   / admin1234    → Admin             ║');
  console.log('║  driver@abzend.com  / driver1234   → Repartidor        ║');
  console.log('║  station@abzend.com / station1234  → Estación          ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('💡 Para resetear los datos: node demo-seed.js --clean');
  console.log('');
}

main().catch(console.error);
