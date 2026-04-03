// property-lookup.js
// PropertyAPI.co integration — free search + 1-credit full record pull
// Called automatically when a contact with APN is saved

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

  const BASE = 'https://api.propertyapi.co/api/v1';
  const headers = { 'X-Api-Key': API_KEY };

  try {
    let uuid = null;
    let resolvedFips = fips || null;

    // ── STEP 1: Free search to get UUID + FIPS (0 credits) ──────────────
    // If we have APN, try that first. Otherwise fall back to address.
    let searchUrl = `${BASE}/parcels/search?`;
    if (apn && resolvedFips) {
      searchUrl += `apn=${encodeURIComponent(apn)}&fips=${resolvedFips}`;
    } else if (apn) {
      searchUrl += `apn=${encodeURIComponent(apn)}`;
    } else if (address) {
      searchUrl += `addr_address=${encodeURIComponent(address)}`;
    }

    const searchRes = await fetch(searchUrl, { headers });
    const searchData = await searchRes.json();

    if (searchData.data && searchData.data.length > 0) {
      const first = searchData.data[0];
      uuid = first.uuid || null;
      resolvedFips = first.fips || resolvedFips;
      console.log('Free search found:', uuid, resolvedFips);
    } else {
      console.log('Free search returned no results. Trying search-by-address...');
    }

    // ── STEP 2: Full record pull (1 credit) ─────────────────────────────
    let fullRecord = null;
    let creditsRemaining = null;

    if (uuid && resolvedFips) {
      // Best path — use UUID + FIPS from free search
      const getUrl = `${BASE}/parcels/get?fips=${resolvedFips}&uuid=${uuid}`;
      const getRes = await fetch(getUrl, { headers });
      const getData = await getRes.json();
      fullRecord = getData.data || null;
      creditsRemaining = getData.credits_remaining;
      console.log('Full record via UUID. Credits remaining:', creditsRemaining);

    } else if (apn && resolvedFips) {
      // Fallback — use APN + FIPS directly
      const getUrl = `${BASE}/parcels/get?fips=${resolvedFips}&apn=${encodeURIComponent(apn)}`;
      const getRes = await fetch(getUrl, { headers });
      const getData = await getRes.json();
      fullRecord = getData.data || null;
      creditsRemaining = getData.credits_remaining;
      console.log('Full record via APN+FIPS. Credits remaining:', creditsRemaining);

    } else {
      // Last resort — search-by-address (1 credit, auto-geocodes)
      const addr = address || `${county} County, ${state}`;
      const addrUrl = `${BASE}/parcels/search-by-address?address=${encodeURIComponent(addr)}`;
      const addrRes = await fetch(addrUrl, { headers });
      const addrData = await addrRes.json();
      fullRecord = addrData.data || null;
      creditsRemaining = addrData.credits_remaining;
      console.log('Full record via address. Credits remaining:', creditsRemaining);
    }

    if (!fullRecord) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, error: 'No property record found', creditsRemaining })
      };
    }

    // ── STEP 3: Extract the fields we care about ─────────────────────────
    // PropertyAPI returns fields as display-name keys — normalize them
    const get = (record, ...keys) => {
      for (const k of keys) {
        if (record[k] !== undefined && record[k] !== null && record[k] !== '') return record[k];
      }
      return null;
    };

    const parsed = {
      // Valuation
      assessedLandValue:  get(fullRecord, 'Assessed Land Value', 'assessed_land_value', 'land_value'),
      assessedTotalValue: get(fullRecord, 'Assessed Total Value', 'assessed_total_value', 'total_assessed_value'),
      marketLandValue:    get(fullRecord, 'Market Land Value', 'market_land_value', 'land_market_value'),
      marketTotalValue:   get(fullRecord, 'Market Total Value', 'market_total_value'),
      estimatedValue:     get(fullRecord, 'Estimated Value', 'estimated_value', 'avm_value'),

      // Last sale
      lastSalePrice:  get(fullRecord, 'Last Sale Price', 'last_sale_price', 'sale_price', 'prior_sale_amount'),
      lastSaleDate:   get(fullRecord, 'Last Sale Date', 'last_sale_date', 'sale_date', 'prior_sale_date'),

      // Owner
      ownerName:    get(fullRecord, 'Owner Name', 'owner_name', 'owner1_name'),
      ownerMailing: get(fullRecord, 'Owner Mailing Address', 'owner_mailing_address', 'mail_address'),

      // Taxes
      annualTaxAmount: get(fullRecord, 'Annual Tax Amount', 'annual_tax_amount', 'tax_amount', 'property_tax'),
      taxYear:         get(fullRecord, 'Tax Year', 'tax_year'),
      taxStatus:       get(fullRecord, 'Tax Status', 'tax_status', 'delinquent_tax'),

      // Parcel
      acreage:    get(fullRecord, 'Lot Size Acres', 'lot_acres', 'acreage', 'lot_size_acres'),
      lotSqft:    get(fullRecord, 'Lot Size Sqft', 'lot_sqft', 'lot_size_sqft'),
      apnConfirm: get(fullRecord, 'APN', 'apn', 'parcel_number'),
      zoning:     get(fullRecord, 'Zoning', 'zoning', 'zoning_code'),
      landUse:    get(fullRecord, 'Land Use', 'land_use', 'property_type'),

      // Location
      address:  get(fullRecord, 'Address', 'address', 'site_address'),
      city:     get(fullRecord, 'City', 'city', 'site_city'),
      state:    get(fullRecord, 'State', 'state', 'site_state'),
      county:   get(fullRecord, 'County', 'county', 'county_name'),
      zip:      get(fullRecord, 'Zip', 'zip', 'zip_code', 'site_zip'),
      lat:      get(fullRecord, 'Latitude', 'latitude', 'lat'),
      lng:      get(fullRecord, 'Longitude', 'longitude', 'lng', 'lon'),

      creditsRemaining,
      rawKeys: Object.keys(fullRecord).slice(0, 30) // for debugging field names
    };

    console.log('Parsed fields:', JSON.stringify(parsed).slice(0, 300));

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
