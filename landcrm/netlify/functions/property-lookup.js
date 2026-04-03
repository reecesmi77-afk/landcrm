// property-lookup.js
// PropertyAPI.co — correct base URL: propertyapi.co (not api.propertyapi.co)
// Uses output_fields to request only land-relevant fields

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const API_KEY = process.env.PROPERTY_API_KEY;
  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'PROPERTY_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const { apn, fips, county, state, address } = body;

  if (!apn && !address) {
    return { statusCode: 400, body: JSON.stringify({ error: 'apn or address required' }) };
  }

  // Correct base URL — propertyapi.co NOT api.propertyapi.co
  const BASE = 'https://propertyapi.co/api/v1';
  const headers = { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' };

  // Fields we care about for land investing
  const OUTPUT_FIELDS = [
    'address', 'city', 'state', 'zip_code', 'county',
    'apn', 'fips_code', 'zoning', 'legal_description',
    'lot_size', 'acres_county', 'acres_county_preferred',
    'property_type', 'land_use_standardized_desc',
    'land_value', 'improvement_value', 'assessed_total', 'market_value',
    'land_market_value', 'market_estimate', 'market_estimate_high', 'market_estimate_low',
    'assessed_value_per_acre', 'market_value_per_acre',
    'last_sale_date', 'last_sale_price', 'prior_sale_date', 'prior_sale_value',
    'annual_tax', 'tax_year', 'tax_delinquent_year',
    'owner', 'owner_name', 'owner_type', 'owner_occupied',
    'mailing_address', 'mailing_city', 'mailing_state', 'mailing_zip',
    'latitude', 'longitude',
    'fema_flood_zone', 'fema_flood_zone_inside_sfha',
    'wetlands_percent',
    'road_within_30ft', 'road_within_160ft',
    'sewer_code', 'sewer_desc', 'water_code', 'water_desc',
    'topography_code', 'topography_desc',
    'homestead_exemption'
  ].join(',');

  try {
    let fullRecord = null;
    let creditsRemaining = null;

    if (apn && fips) {
      // Best path — FIPS + APN direct lookup (1 credit)
      console.log('Trying FIPS + APN lookup:', fips, apn);
      const url = `${BASE}/parcels/get?fips=${fips}&apn=${encodeURIComponent(apn)}&output_fields=${OUTPUT_FIELDS}`;
      const res = await fetch(url, { headers });
      const data = await res.json();
      console.log('FIPS+APN response status:', data.status, 'credits:', data.credits_remaining);
      if (data.status === 'ok' && data.data) {
        fullRecord = data.data;
        creditsRemaining = data.credits_remaining;
      }
    }

    if (!fullRecord && address) {
      // Fallback — search by address (1 credit, auto-geocodes)
      console.log('Trying address lookup:', address);
      const url = `${BASE}/parcels/search-by-address?address=${encodeURIComponent(address)}&output_fields=${OUTPUT_FIELDS}`;
      const res = await fetch(url, { headers });
      const data = await res.json();
      console.log('Address response status:', data.status, 'credits:', data.credits_remaining);
      if (data.status === 'ok' && data.data) {
        fullRecord = data.data;
        creditsRemaining = data.credits_remaining;
      }
    }

    if (!fullRecord && county && state) {
      // Last resort — county + state address
      const fallbackAddr = `${county} County, ${state}`;
      console.log('Trying county fallback:', fallbackAddr);
      const url = `${BASE}/parcels/search-by-address?address=${encodeURIComponent(fallbackAddr)}&output_fields=${OUTPUT_FIELDS}`;
      const res = await fetch(url, { headers });
      const data = await res.json();
      if (data.status === 'ok' && data.data) {
        fullRecord = data.data;
        creditsRemaining = data.credits_remaining;
      }
    }

    if (!fullRecord) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, error: 'No property record found', creditsRemaining })
      };
    }

    // Map snake_case field names from API to our display names
    const d = fullRecord;
    const parsed = {
      // Valuation
      assessedLandValue:  d.land_value || null,
      assessedTotalValue: d.assessed_total || null,
      marketLandValue:    d.land_market_value || d.market_value || null,
      marketEstimate:     d.market_estimate || null,
      marketEstimateHigh: d.market_estimate_high || null,
      marketEstimateLow:  d.market_estimate_low || null,
      valuePerAcre:       d.assessed_value_per_acre || d.market_value_per_acre || null,

      // Last sale
      lastSalePrice:  d.last_sale_price || null,
      lastSaleDate:   d.last_sale_date || null,
      priorSalePrice: d.prior_sale_value || null,
      priorSaleDate:  d.prior_sale_date || null,

      // Owner
      ownerName:    d.owner_name || d.owner || null,
      ownerType:    d.owner_type || null,
      ownerOccupied: d.owner_occupied || null,
      mailingAddress: [d.mailing_address, d.mailing_city, d.mailing_state, d.mailing_zip].filter(Boolean).join(', ') || null,

      // Taxes
      annualTaxAmount:     d.annual_tax || null,
      taxYear:             d.tax_year || null,
      taxDelinquentYear:   d.tax_delinquent_year || null,
      homesteadExemption:  d.homestead_exemption || null,

      // Parcel
      acreage:     d.acres_county_preferred || d.acres_county || d.lot_size || null,
      zoning:      d.zoning || null,
      landUse:     d.land_use_standardized_desc || d.property_type || null,
      legalDesc:   d.legal_description || null,

      // Location
      address:  d.address || null,
      city:     d.city || null,
      state:    d.state || null,
      county:   d.county || null,
      zip:      d.zip_code || null,
      lat:      d.latitude || null,
      lng:      d.longitude || null,

      // Environmental — huge for land
      floodZone:        d.fema_flood_zone || null,
      insideSFHA:       d.fema_flood_zone_inside_sfha || null,
      wetlandsPercent:  d.wetlands_percent || null,
      roadWithin30ft:   d.road_within_30ft || null,
      roadWithin160ft:  d.road_within_160ft || null,
      sewerType:        d.sewer_desc || d.sewer_code || null,
      waterType:        d.water_desc || d.water_code || null,
      topography:       d.topography_desc || d.topography_code || null,

      creditsRemaining,
      rawKeys: Object.keys(d).slice(0, 40)
    };

    console.log('Successfully parsed record for:', parsed.address || 'unknown address');
    console.log('Key values — Land value:', parsed.assessedLandValue, 'Last sale:', parsed.lastSalePrice, 'Owner:', parsed.ownerName);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, data: parsed, creditsRemaining })
    };

  } catch(err) {
    console.error('PropertyAPI error:', err.message);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

// ── SKIP TRACE ENDPOINT ──────────────────────────────────────────────
// Called separately via POST with action: 'skip-trace'
// 2 credits per lookup, returns phone numbers + emails
