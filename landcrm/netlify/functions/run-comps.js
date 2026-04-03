// run-comps.js
// PropertyAPI.co radius search — finds comparable sold parcels near subject
// Cascade: 3mi/90d → 3mi/180d → 10mi/180d → 25mi/365d
// Credits: 1 per parcel returned (only charged on export step)

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const API_KEY = process.env.PROPERTY_API_KEY;
  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'PROPERTY_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const { lat, lng, acreage, contactName } = body;

  if (!lat || !lng) {
    return { statusCode: 400, body: JSON.stringify({ error: 'lat and lng required — run county record first to get coordinates' }) };
  }

  const BASE = 'https://propertyapi.co/api/v1';
  const headers = { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' };

  // Acreage filters — search within 50% of subject size
  const subjectAcres = parseFloat(acreage) || 5;
  const acresFrom = Math.max(0.1, subjectAcres * 0.25);
  const acresTo = subjectAcres * 4;

  // Comp fields we want
  const OUTPUT_FIELDS = [
    'address', 'city', 'state', 'county', 'zip_code',
    'apn', 'acres_county_preferred', 'lot_size',
    'last_sale_date', 'last_sale_price', 'sale_value_per_acre',
    'land_value', 'assessed_total', 'market_value', 'market_estimate',
    'property_type', 'land_use_standardized_desc', 'zoning',
    'fema_flood_zone', 'road_within_30ft',
    'latitude', 'longitude'
  ].join(',');

  // Search cascade — progressively widen until we get at least 3 comps
  const cascades = [
    { radius: 3,  days: 90,  label: '3 miles / 90 days' },
    { radius: 3,  days: 180, label: '3 miles / 180 days' },
    { radius: 10, days: 180, label: '10 miles / 180 days' },
    { radius: 25, days: 365, label: '25 miles / 12 months' },
  ];

  const MIN_COMPS = 3;
  const MAX_COMPS = 12; // pull more to account for ag filtering

  let comps = [];
  let usedCascade = null;
  let totalCreditsUsed = 0;

  try {
    for (const cascade of cascades) {
      console.log(`Trying cascade: ${cascade.label}, acres ${acresFrom.toFixed(1)}-${acresTo.toFixed(1)}`);

      // Step 1: Count (free)
      const countRes = await fetch(`${BASE}/parcels/count`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: {
            latitude: lat,
            longitude: lng,
            radius_miles: cascade.radius,
            acres_from: acresFrom,
            acres_to: acresTo,
          }
        })
      });
      const countData = await countRes.json();
      console.log(`Count result: ${countData.data?.count} parcels, token: ${countData.data?.export_token}`);

      if (countData.status !== 'ok' || !countData.data?.count) {
        console.log('No results at this cascade level, widening...');
        continue;
      }

      const parcelCount = Math.min(countData.data.count, MAX_COMPS);
      const exportToken = countData.data.export_token;

      // Step 2: Export (charges credits)
      const exportRes = await fetch(`${BASE}/parcels/export`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ export_token: exportToken })
      });
      const exportData = await exportRes.json();
      console.log('Export status:', exportData.status, 'credits used:', exportData.credits_used);

      if (exportData.status !== 'ok') {
        console.log('Export failed:', exportData);
        continue;
      }

      totalCreditsUsed += exportData.data?.creditsUsed || parcelCount;

      // Step 3: Poll for completion
      const token = exportData.data?.export_token || exportToken;
      let downloadUrl = null;
      let attempts = 0;

      while (attempts < 15 && !downloadUrl) {
        await new Promise(r => setTimeout(r, 1500));
        const pollRes = await fetch(`${BASE}/parcels/export/${token}`, { headers: { 'X-Api-Key': API_KEY } });
        const pollData = await pollRes.json();
        console.log(`Poll ${attempts+1}: ${pollData.data?.jobStatus} ${pollData.data?.progressPercent}%`);

        if (pollData.data?.jobStatus === 'completed') {
          downloadUrl = pollData.data.downloadUrl;
          break;
        }
        attempts++;
      }

      if (!downloadUrl) {
        console.log('Export timed out');
        continue;
      }

      // Step 4: Download CSV
      const dlRes = await fetch(`${BASE}/parcels/download?url=${encodeURIComponent(downloadUrl)}&output_fields=${OUTPUT_FIELDS}`, {
        headers: { 'X-Api-Key': API_KEY }
      });
      const csvText = await dlRes.text();
      console.log('CSV received, length:', csvText.length);

      // Parse CSV
      const rows = csvText.trim().split('\n');
      if (rows.length < 2) continue;

      const headers_csv = rows[0].split(',').map(h => h.trim().replace(/"/g, ''));
      const dataRows = rows.slice(1);

      const parsed = dataRows.map(row => {
        const vals = row.split(',').map(v => v.trim().replace(/"/g, ''));
        const obj = {};
        headers_csv.forEach((h, i) => { obj[h] = vals[i] || ''; });
        return obj;
      }).filter(r => r.last_sale_price && parseFloat(r.last_sale_price) > 0);

      // Filter to only sold properties within our date window
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - cascade.days);

      // Exclude active row crop / cultivated agricultural land
      // Keep: pasture, ranch, timber, recreational, vacant, residential, rural
      const AG_EXCLUDE = [
        'row crop', 'cultivated', 'cropland', 'crop land',
        'orchard', 'vineyard', 'dairy', 'poultry', 'hog',
        'feed lot', 'feedlot', 'irrigated farm', 'dry farm',
        'truck farm', 'nursery', 'greenhouse'
      ];

      const landUseFiltered = parsed.filter(r => {
        const lu = (r.land_use_standardized_desc || '').toLowerCase();
        const pt = (r.property_type || '').toLowerCase();
        const combined = lu + ' ' + pt;
        // Exclude if any ag exclusion keyword matches
        return !AG_EXCLUDE.some(kw => combined.includes(kw));
      });

      console.log(`Land use filtered: ${parsed.length} → ${landUseFiltered.length} (removed ${parsed.length - landUseFiltered.length} row crop/ag parcels)`);

      const filtered = landUseFiltered.filter(r => {
        if (!r.last_sale_date) return false;
        const saleDate = new Date(r.last_sale_date);
        return saleDate >= cutoffDate;
      });

      console.log(`Filtered to ${filtered.length} sold comps within ${cascade.days} days`);

      if (filtered.length >= MIN_COMPS || cascade === cascades[cascades.length - 1]) {
        comps = filtered.slice(0, 8); // show max 8 comps in results
        usedCascade = cascade;
        break;
      }

      console.log(`Only ${filtered.length} comps — widening search...`);
    }

    if (!comps.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: 'No comparable sales found in any radius. This market may have very thin data.',
          creditsUsed: totalCreditsUsed
        })
      };
    }

    // Calculate price per acre for each comp
    const enriched = comps.map(r => {
      const acres = parseFloat(r.acres_county_preferred || r.lot_size || 0);
      const price = parseFloat(r.last_sale_price || 0);
      const pricePerAcre = acres > 0 ? Math.round(price / acres) : null;

      // Distance from subject (rough haversine)
      const compLat = parseFloat(r.latitude || 0);
      const compLng = parseFloat(r.longitude || 0);
      let distanceMiles = null;
      if (compLat && compLng) {
        const R = 3959;
        const dLat = (compLat - lat) * Math.PI / 180;
        const dLng = (compLng - lng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat*Math.PI/180)*Math.cos(compLat*Math.PI/180)*Math.sin(dLng/2)**2;
        distanceMiles = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 10) / 10;
      }

      return {
        address: r.address || 'Unknown',
        city: r.city || '',
        county: r.county || '',
        state: r.state || '',
        acres: acres || null,
        salePrice: price || null,
        saleDate: r.last_sale_date || null,
        pricePerAcre,
        assessedValue: parseFloat(r.land_value || r.assessed_total || 0) || null,
        zoning: r.zoning || null,
        floodZone: r.fema_flood_zone || null,
        roadAccess: r.road_within_30ft || null,
        distanceMiles,
        lat: compLat || null,
        lng: compLng || null,
      };
    }).filter(r => r.salePrice > 0);

    // Calculate median price per acre
    const validPPA = enriched.map(r => r.pricePerAcre).filter(Boolean).sort((a, b) => a - b);
    const medianPPA = validPPA.length
      ? validPPA[Math.floor(validPPA.length / 2)]
      : null;

    const avgPPA = validPPA.length
      ? Math.round(validPPA.reduce((a, b) => a + b, 0) / validPPA.length)
      : null;

    // Confidence rating
    const confidence = comps.length >= 5 && usedCascade.radius <= 3 ? 'High'
      : comps.length >= 3 && usedCascade.radius <= 10 ? 'Medium'
      : 'Low';

    const result = {
      ok: true,
      comps: enriched,
      summary: {
        compCount: enriched.length,
        medianPricePerAcre: medianPPA,
        avgPricePerAcre: avgPPA,
        searchRadius: usedCascade.radius,
        searchDays: usedCascade.days,
        cascadeLabel: usedCascade.label,
        confidence,
        suggestedOfferPerAcre: medianPPA ? Math.round(medianPPA * 0.45) : null,
        maoPerAcre: medianPPA ? Math.round(medianPPA * 0.60) : null,
      },
      creditsUsed: totalCreditsUsed,
    };

    console.log(`Comps complete: ${enriched.length} comps, median $${medianPPA}/acre, confidence: ${confidence}`);
    return { statusCode: 200, body: JSON.stringify(result) };

  } catch(err) {
    console.error('Comps error:', err.message);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: err.message, creditsUsed: totalCreditsUsed })
    };
  }
};
