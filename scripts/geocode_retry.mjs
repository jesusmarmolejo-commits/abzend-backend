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
async function fetchNullCoords(table, idColumn, addressColumn, latColumn, createdAfter = null) {
  let query = supabase
    .from(table)
    .select(`${idColumn}, ${addressColumn}`)
    .is(latColumn, null)
    .not(addressColumn, 'is', null);

  if (createdAfter) {
    query = query.gte('created_at', createdAfter);
  }

  return query;
}

async function fetchStopsNullCoords(createdAfter = null) {
  let query = supabase
    .from('transport_order_stops')
    .select('id, calle, transport_orders!inner(created_at)')
    .is('lat', null)
    .not('calle', 'is', null);

  if (createdAfter) {
    query = query.gte('transport_orders.created_at', createdAfter);
  }

  return query;
}

async function processSection(table, idColumn, addressColumn, latColumn, lngColumn, sectionLabel, createdAfter = null) {
  const { data: rows, error } = await fetchNullCoords(table, idColumn, addressColumn, latColumn, createdAfter);

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

async function processSectionStops(createdAfter = null) {
  const { data: rows, error } = await fetchStopsNullCoords(createdAfter);

  if (error) {
    console.log(`  ! fetch error: ${error.message}`);
    return { updated: 0, sinResultado: 0, errores: 1 };
  }

  let updated = 0, sinResultado = 0, errores = 0;

  for (const row of rows) {
    const id = row.id;
    const address = row.calle;
    try {
      const { lat, lng, provider } = await geocodeAddress(address);
      if (lat !== null && lng !== null) {
        const { error: updateError } = await supabase
          .from('transport_order_stops')
          .update({ lat, lng })
          .eq('id', id);
        if (updateError) { console.log(`  ! #${id}  "${address}"  -> error: ${updateError.message}`); errores++; }
        else { console.log(`  ✓ #${id}  "${address}"  -> ${lat}, ${lng}  (${provider})`); updated++; }
      } else {
        console.log(`  ✗ #${id}  "${address}"  -> sin resultado`); sinResultado++;
      }
    } catch (err) {
      console.log(`  ! #${id}  "${address}"  -> error: ${err.message}`); errores++;
    }
  }

  return { updated, sinResultado, errores };
}

async function main() {
  const startTime = Date.now();
  console.log(`=== GEOCODE RETRY JOB — ${new Date().toISOString()} ===\n`);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  console.log(`  Filtrando ordenes creadas después de: ${oneHourAgo}\n`);

  console.log('[orders -> dest]');
  const destResult = await processSection(
    'orders', 'id', 'dest_address', 'dest_lat', 'dest_lng', 'orders -> dest', oneHourAgo
  );

  console.log('\n[orders -> origin]');
  const originResult = await processSection(
    'orders', 'id', 'origin_address', 'origin_lat', 'origin_lng', 'orders -> origin', oneHourAgo
  );

  console.log('\n[transport_order_stops]');
  const stopsResult = await processSectionStops(oneHourAgo);

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
