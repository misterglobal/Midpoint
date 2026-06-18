/*
  Express API server exposing POST /midpoint
  - Accepts JSON body: { address1: string, address2: string }
  - Uses Google Maps Geocoding API to geocode both addresses
  - Calculates geographic midpoint
  - Uses Google Places Nearby Search to find cafes near the midpoint
  - Returns JSON with midpoint and list of cafes

  Setup:
    1) Install dependencies:
       npm init -y && npm install express axios dotenv
    2) Create a .env file with:
       GOOGLE_MAPS_API_KEY=your_api_key_here
    3) Run:
       node app.js

  Notes:
    - This implementation uses the v1 Geocoding API (maps.googleapis.com/maps/api/geocode/json)
    - Places Nearby Search endpoint: maps.googleapis.com/maps/api/place/nearbysearch/json
    - For production, consider enabling rate limiting, caching, stricter validation, and error monitoring.
*/

const express = require('express');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.static(path.join(__dirname)));
const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

if (!GOOGLE_MAPS_API_KEY) {
  console.warn('Warning: GOOGLE_MAPS_API_KEY is not set. Set it in a .env file.');
}

// Enable CORS for all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Helper: geocode an address to { lat, lng }
async function geocodeAddress(address) {
  if (!address || typeof address !== 'string') {
    throw new Error('Invalid address');
  }
  const url = 'https://maps.googleapis.com/maps/api/geocode/json';
  const params = {
    address,
    key: GOOGLE_MAPS_API_KEY,
  };
  const resp = await axios.get(url, { params });
  if (resp.data.status !== 'OK' || !resp.data.results?.length) {
    const msg = resp.data.error_message || resp.data.status || 'Geocoding failed';
    const details = resp.data.results?.[0]?.partial_match ? 'Partial match' : undefined;
    throw new Error(`Geocoding error for "${address}": ${msg}${details ? ' - ' + details : ''}`);
  }
  const location = resp.data.results[0].geometry.location; // { lat, lng }
  return { lat: location.lat, lng: location.lng };
}

// Helper: compute geographic midpoint for two coordinates
function computeMidpoint(coord1, coord2) {
  // Simple average is acceptable for short distances; for robustness, use spherical midpoint.
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const lat1 = toRad(coord1.lat);
  const lon1 = toRad(coord1.lng);
  const lat2 = toRad(coord2.lat);
  const lon2 = toRad(coord2.lng);

  const dLon = lon2 - lon1;

  const Bx = Math.cos(lat2) * Math.cos(dLon);
  const By = Math.cos(lat2) * Math.sin(dLon);

  const lat3 = Math.atan2(
    Math.sin(lat1) + Math.sin(lat2),
    Math.sqrt((Math.cos(lat1) + Bx) * (Math.cos(lat1) + Bx) + By * By)
  );
  const lon3 = lon1 + Math.atan2(By, Math.cos(lat1) + Bx);

  return { lat: toDeg(lat3), lng: toDeg(lon3) };
}

// Helper: find nearby cafes around a location using Places Nearby Search
async function findNearbyCafes({ lat, lng }, radiusMeters = 1500, maxResults = 20) {
  const url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
  const params = {
    key: GOOGLE_MAPS_API_KEY,
    location: `${lat},${lng}`,
    radius: radiusMeters,
    type: 'cafe',
    // rankby cannot be used with radius when set to distance; we keep radius to constrain area
  };

  const resp = await axios.get(url, { params });
  if (resp.data.status !== 'OK' && resp.data.status !== 'ZERO_RESULTS') {
    const msg = resp.data.error_message || resp.data.status || 'Places search failed';
    throw new Error(`Places API error: ${msg}`);
  }

  const results = (resp.data.results || []).slice(0, maxResults).map((r) => ({
    place_id: r.place_id,
    name: r.name,
    rating: r.rating,
    user_ratings_total: r.user_ratings_total,
    price_level: r.price_level,
    address: r.vicinity || r.formatted_address,
    location: r.geometry?.location,
    open_now: r.opening_hours?.open_now,
    types: r.types,
  }));

  return results;
}

app.post('/midpoint', async (req, res) => {
  try {
    const { address1, address2, radiusMeters, maxResults } = req.body || {};
    if (!address1 || !address2) {
      return res.status(400).json({ error: 'Both address1 and address2 are required.' });
    }

    const [coord1, coord2] = await Promise.all([
      geocodeAddress(address1),
      geocodeAddress(address2),
    ]);

    const midpoint = computeMidpoint(coord1, coord2);

    const cafes = await findNearbyCafes(
      midpoint,
      Number.isFinite(radiusMeters) ? radiusMeters : 1500,
      Number.isFinite(maxResults) ? maxResults : 20
    );

    return res.json({
      input: { address1, address2 },
      coordinates: { address1: coord1, address2: coord2 },
      midpoint,
      cafes,
    });
  } catch (err) {
    const status = 502; // Bad gateway for upstream API errors
    return res.status(status).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
