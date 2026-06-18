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

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', quiet: true });

const app = express();
app.use(express.static(path.join(__dirname)));
const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GOOGLE_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_RADIUS_METERS = 1500;
const DEFAULT_MAX_RESULTS = 20;
const MIN_RADIUS_METERS = 100;
const MAX_RADIUS_METERS = 50000;
const MIN_RESULTS = 1;
const MAX_RESULTS = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!GOOGLE_MAPS_API_KEY) {
  console.warn('Warning: GOOGLE_MAPS_API_KEY is not set. Set it in a .env file.');
}

class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Enable CORS. Set ALLOWED_ORIGINS as a comma-separated list in production.
app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  const allowedOrigin = allowedOrigins.length === 0
    ? '*'
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : '';

  if (allowedOrigin) {
    res.header('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '10kb' }));

const rateLimitBuckets = new Map();

app.use((req, res, next) => {
  if (req.path !== '/midpoint' || req.method !== 'POST') {
    return next();
  }

  const now = Date.now();
  const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);

  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many searches. Please wait a minute and try again.' });
  }

  return next();
});

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(number), min), max);
}

function normalizeAddress(value, fieldName) {
  if (typeof value !== 'string') {
    throw new AppError(`${fieldName} must be text.`, 400);
  }

  const address = value.trim().replace(/\s+/g, ' ');
  if (address.length < 3) {
    throw new AppError(`${fieldName} must be at least 3 characters long.`, 400);
  }

  if (address.length > 300) {
    throw new AppError(`${fieldName} must be 300 characters or less.`, 400);
  }

  return address;
}

function validateSearchRequest(body = {}) {
  return {
    address1: normalizeAddress(body.address1, 'Address 1'),
    address2: normalizeAddress(body.address2, 'Address 2'),
    radiusMeters: clampNumber(body.radiusMeters, DEFAULT_RADIUS_METERS, MIN_RADIUS_METERS, MAX_RADIUS_METERS),
    maxResults: clampNumber(body.maxResults, DEFAULT_MAX_RESULTS, MIN_RESULTS, MAX_RESULTS),
  };
}

function mapGoogleStatus(status, fallbackMessage) {
  if (status === 'ZERO_RESULTS') {
    return new AppError('We could not find one of those addresses. Try adding a city, province/state, or postal code.', 404);
  }

  if (status === 'REQUEST_DENIED') {
    return new AppError('The map service rejected this request. Please check the Google Maps API key configuration.', 502);
  }

  if (status === 'OVER_QUERY_LIMIT') {
    return new AppError('The map service quota has been reached. Please try again later.', 503);
  }

  return new AppError(fallbackMessage, 502);
}

// Helper: geocode an address to { lat, lng }
async function geocodeAddress(address) {
  if (!address || typeof address !== 'string') {
    throw new AppError('Invalid address.', 400);
  }
  const url = 'https://maps.googleapis.com/maps/api/geocode/json';
  const params = {
    address,
    key: GOOGLE_MAPS_API_KEY,
  };
  const resp = await axios.get(url, { params, timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  if (resp.data.status !== 'OK' || !resp.data.results?.length) {
    throw mapGoogleStatus(resp.data.status, `We could not geocode "${address}". Please check the address and try again.`);
  }
  const location = resp.data.results[0].geometry.location; // { lat, lng }

  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
    throw new AppError('The map service returned an invalid location.', 502);
  }

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

  const resp = await axios.get(url, { params, timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  if (resp.data.status !== 'OK' && resp.data.status !== 'ZERO_RESULTS') {
    throw mapGoogleStatus(resp.data.status, 'The cafe search failed. Please try again in a moment.');
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
    const { address1, address2, radiusMeters, maxResults } = validateSearchRequest(req.body);

    const [coord1, coord2] = await Promise.all([
      geocodeAddress(address1),
      geocodeAddress(address2),
    ]);

    const midpoint = computeMidpoint(coord1, coord2);

    const cafes = await findNearbyCafes(
      midpoint,
      radiusMeters,
      maxResults
    );

    return res.json({
      input: { address1, address2 },
      options: { radiusMeters, maxResults },
      coordinates: { address1: coord1, address2: coord2 },
      midpoint,
      cafes,
    });
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'The map service took too long to respond. Please try again.' });
    }

    const status = err.statusCode || 502;
    return res.status(status).json({ error: err.message || 'Something went wrong while finding cafes.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  clampNumber,
  computeMidpoint,
  validateSearchRequest,
};
