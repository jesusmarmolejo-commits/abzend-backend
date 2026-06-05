import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const NOMINATIM_UA = 'ABZEND/1.0 logistics@abzend.mx';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildSimplifiedAddress(address) {
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length <= 3) return address + ', Mexico';
  return parts.slice(-3).join(', ') + ', Mexico';
}

async function geocodeNominatim(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}&countrycodes=mx`;
  const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
  await sleep(1000);
  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), provider: 'nominatim' };
  }
  return null;
}

async function geocodeNominatimSimple(address) {
  const simplified = buildSimplifiedAddress(address);
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(simplified)}&countrycodes=mx`;
  const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
  await sleep(1000);
  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), provider: 'nominatim-simple' };
  }
  return null;
}

async function geocodePhoton(address) {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(address)}&limit=1&lang=es`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ABZEND/1.0 logistics@abzend.mx' } });
  await sleep(1000);
  const data = await res.json();
  if (data.features && data.features.length > 0) {
    const [lng, lat] = data.features[0].geometry.coordinates;
    return { lat, lng, provider: 'photon' };
  }
  return null;
}

async function geocodeAddress(address) {
  let result = await geocodeNominatim(address);
  if (result) return result;

  result = await geocodeNominatimSimple(address);
  if (result) return result;

  result = await geocodePhoton(address);
  if (result) return result;

  return { lat: null, lng: null, provider: null };
}

// Filters chained as AND: latColumn IS NULL AND addressColumn IS NOT NULL
async function fetchNullCoords(table, idColumn, addressColumn, latColumn) {
  return supabase
    .from(table)
    .select(`${idColumn}, ${addressColumn}`)
    .is(latColumn, null)
    .not(addressColumn, 'is', null);
}

async function processSection(table, idColumn, addressColumn, latColumn, lngColumn, sectionLabel) {
  const { data: rows, error } = await fetchNullCoords(table, idColumn, addressColumn, latColumn);

  if (error) {
    console.log(`  ! fetch error: ${error.message}`);
    return { updated: 0, sinResultado: 0, errores: 1 };
  }

  let updated = 0;
  let sinResultado = 0;
  let errores = 0;

  for (const row of rows) {
    const id = row[idColumn];
    const address = row[addressColumn];

    try {
      const { lat, lng, provider } = await geocodeAddress(address);

      if (lat !== null && lng !== null) {
        const { error: updateError } = await supabase
          .from(table)
          .update({ [latColumn]: lat, [lngColumn]: lng })
          .eq(idColumn, id);

        if (updateError) {
          console.log(`  ! #${id}  "${address}"  -> error: ${updateError.message}`);
          errores++;
        } else {
          console.log(`  ✓ #${id}  "${address}"  -> ${lat}, ${lng}  (${provider})`);
          updated++;
        }
      } else {
        console.log(`  ✗ #${id}  "${address}"  -> sin resultado`);
        sinResultado++;
      }
    } catch (err) {
      console.log(`  ! #${id}  "${address}"  -> error: ${err.message}`);
      errores++;
    }
  }

  return { updated, sinResultado, errores };
}

async function main() {
  const startTime = Date.now();
  console.log(`=== GEOCODE RETRY JOB — ${new Date().toISOString()} ===\n`);

  console.log('[orders -> dest]');
  const destResult = await processSection(
    'orders', 'id', 'dest_address', 'dest_lat', 'dest_lng', 'orders -> dest'
  );

  console.log('\n[orders -> origin]');
  const originResult = await processSection(
    'orders', 'id', 'origin_address', 'origin_lat', 'origin_lng', 'orders -> origin'
  );

  console.log('\n[transport_order_stops]');
  const stopsResult = await processSection(
    'transport_order_stops', 'id', 'calle', 'lat', 'lng', 'transport_order_stops'
  );

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalUpdated = destResult.updated + originResult.updated + stopsResult.updated;
  const totalSinResultado = destResult.sinResultado + originResult.sinResultado + stopsResult.sinResultado;
  const totalErrores = destResult.errores + originResult.errores + stopsResult.errores;

  console.log(`\n=== RESUMEN ===`);
  console.log(`orders.dest:           ${destResult.updated} actualizadas / ${destResult.sinResultado} sin resultado / ${destResult.errores} errores`);
  console.log(`orders.origin:         ${originResult.updated} actualizadas / ${originResult.sinResultado} sin resultado / ${originResult.errores} errores`);
  console.log(`transport_order_stops: ${stopsResult.updated} actualizadas / ${stopsResult.sinResultado} sin resultado / ${stopsResult.errores} errores`);
  console.log(`Total geocodificadas: ${totalUpdated} | Sin resultado: ${totalSinResultado} | Errores: ${totalErrores}`);
  console.log(`Duracion: ${duration}s`);
  console.log(`===`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
