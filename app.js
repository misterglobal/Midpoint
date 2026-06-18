/*
  Express API server exposing POST /midpoint
  - Accepts JSON body: { locations: string[], travelModes?: string[], venueType?: string }
  - Also supports legacy { address1: string, address2: string }
  - Geocodes all locations and calculates a geographic center
  - Uses Google Places Nearby Search to find venues near the center
  - Optionally enriches venues with Routes API travel-time matrix data
  - Returns scored venue recommendations with fairness, quality, safety, and parking signals

  Setup:
    1) Install dependencies:
       npm init -y && npm install express axios dotenv
    2) Create a .env file with:
       GOOGLE_MAPS_API_KEY=your_api_key_here
       API_KEYS=comma,separated,client,keys
    3) Run:
       node app.js

  Notes:
    - This implementation uses the v1 Geocoding API (maps.googleapis.com/maps/api/geocode/json)
    - Places Nearby Search endpoint: maps.googleapis.com/maps/api/place/nearbysearch/json
    - For production, consider enabling rate limiting, caching, stricter validation, and error monitoring.
*/

const express = require('express');
const path = require('path');
const crypto = require('crypto');
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
const SUPPORTED_TRAVEL_MODES = new Set(['driving', 'transit', 'walking']);
const ROUTES_API_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const API_KEYS = getConfiguredApiKeys();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!GOOGLE_MAPS_API_KEY) {
  console.warn('Warning: GOOGLE_MAPS_API_KEY is not set. Set it in a .env file.');
}

if (API_KEYS.length === 0) {
  console.warn('Warning: no backend API keys configured. POST /midpoint is open.');
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
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  if (req.path !== '/midpoint' || req.method !== 'POST' || API_KEYS.length === 0) {
    return next();
  }

  const apiKey = getRequestApiKey(req);
  if (!isAuthorizedApiKey(apiKey, API_KEYS)) {
    return res.status(401).json({ error: 'Unauthorized. Provide a valid API key.' });
  }

  return next();
});

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

function getConfiguredApiKeys() {
  return [
    process.env.API_KEYS,
    process.env.API_KEY,
    process.env.X_API_KEY,
    process.env['X-API-Key'],
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function getRequestApiKey(req) {
  const authHeader = req.get('Authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  return req.get('X-API-Key') || '';
}

function isAuthorizedApiKey(candidate, allowedKeys = API_KEYS) {
  if (!candidate || allowedKeys.length === 0) {
    return false;
  }

  return allowedKeys.some((allowedKey) => safeCompare(candidate, allowedKey));
}

function safeCompare(candidate, allowedKey) {
  const candidateBuffer = Buffer.from(String(candidate));
  const allowedBuffer = Buffer.from(String(allowedKey));

  if (candidateBuffer.length !== allowedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuffer, allowedBuffer);
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
  const locations = Array.isArray(body.locations)
    ? body.locations
    : [body.address1, body.address2].filter((value) => value !== undefined);
  const normalizedLocations = locations.map((location, index) => (
    normalizeAddress(location, `Location ${index + 1}`)
  ));

  if (normalizedLocations.length < 2) {
    throw new AppError('At least two locations are required.', 400);
  }

  if (normalizedLocations.length > 10) {
    throw new AppError('A maximum of 10 locations is supported per search.', 400);
  }

  const travelModes = Array.isArray(body.travelModes)
    ? body.travelModes.map((mode) => String(mode).toLowerCase())
    : ['driving'];
  const normalizedTravelModes = [...new Set(travelModes)]
    .filter((mode) => SUPPORTED_TRAVEL_MODES.has(mode));

  return {
    locations: normalizedLocations,
    address1: normalizedLocations[0],
    address2: normalizedLocations[1],
    radiusMeters: clampNumber(body.radiusMeters, DEFAULT_RADIUS_METERS, MIN_RADIUS_METERS, MAX_RADIUS_METERS),
    maxResults: clampNumber(body.maxResults, DEFAULT_MAX_RESULTS, MIN_RESULTS, MAX_RESULTS),
    venueType: typeof body.venueType === 'string' && body.venueType.trim()
      ? body.venueType.trim().toLowerCase()
      : 'cafe',
    travelModes: normalizedTravelModes.length > 0 ? normalizedTravelModes : ['driving'],
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

function computeGeographicCenter(coords) {
  const validCoords = coords.filter(isFiniteCoord);
  if (validCoords.length === 0) {
    return null;
  }

  if (validCoords.length === 2) {
    return computeMidpoint(validCoords[0], validCoords[1]);
  }

  const totals = validCoords.reduce((acc, coord) => {
    const lat = (coord.lat * Math.PI) / 180;
    const lng = (coord.lng * Math.PI) / 180;

    acc.x += Math.cos(lat) * Math.cos(lng);
    acc.y += Math.cos(lat) * Math.sin(lng);
    acc.z += Math.sin(lat);
    return acc;
  }, { x: 0, y: 0, z: 0 });

  const count = validCoords.length;
  const x = totals.x / count;
  const y = totals.y / count;
  const z = totals.z / count;
  const lng = Math.atan2(y, x);
  const hyp = Math.sqrt((x * x) + (y * y));
  const lat = Math.atan2(z, hyp);

  return {
    lat: (lat * 180) / Math.PI,
    lng: (lng * 180) / Math.PI,
  };
}

function computeDistanceMeters(coord1, coord2) {
  if (!isFiniteCoord(coord1) || !isFiniteCoord(coord2)) {
    return null;
  }

  const earthRadiusMeters = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(coord2.lat - coord1.lat);
  const dLng = toRad(coord2.lng - coord1.lng);
  const lat1 = toRad(coord1.lat);
  const lat2 = toRad(coord2.lat);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(earthRadiusMeters * c);
}

function isFiniteCoord(value) {
  return Number.isFinite(value?.lat) && Number.isFinite(value?.lng);
}

function roundScore(value) {
  return Math.round(value * 100) / 100;
}

function computeFairnessScore(distanceFromAddress1Meters, distanceFromAddress2Meters) {
  const distances = Array.isArray(distanceFromAddress1Meters)
    ? distanceFromAddress1Meters.filter(Number.isFinite)
    : [distanceFromAddress1Meters, distanceFromAddress2Meters].filter(Number.isFinite);

  if (distances.length < 2) {
    return null;
  }

  const fartherDistance = Math.max(...distances);
  if (fartherDistance === 0) {
    return 1;
  }

  const imbalanceMeters = Math.max(...distances) - Math.min(...distances);
  return roundScore(Math.max(0, 1 - (imbalanceMeters / fartherDistance)));
}

function computeQualityScore(cafe) {
  const rating = Number(cafe.rating);
  const reviewCount = Number(cafe.user_ratings_total) || 0;
  const ratingScore = Number.isFinite(rating) ? rating / 5 : 0.55;
  const reviewScore = Math.min(Math.log10(reviewCount + 1) / 3, 1);
  const openScore = cafe.open_now === true ? 1 : cafe.open_now === false ? 0.35 : 0.65;

  return roundScore((ratingScore * 0.55) + (reviewScore * 0.25) + (openScore * 0.20));
}

function computeMeetingScore({ fairnessScore, qualityScore, distanceMeters, radiusMeters }) {
  const distanceScore = Number.isFinite(distanceMeters)
    ? Math.max(0, 1 - (distanceMeters / Math.max(radiusMeters, 1)))
    : 0.5;
  const normalizedFairness = Number.isFinite(fairnessScore) ? fairnessScore : 0.5;

  return roundScore((normalizedFairness * 0.45) + (qualityScore * 0.35) + (distanceScore * 0.20));
}

function computeTravelScore(travelSummary) {
  const modeSummaries = Object.values(travelSummary || {})
    .filter((summary) => Number.isFinite(summary.fairnessScore));

  if (modeSummaries.length === 0) {
    return null;
  }

  const total = modeSummaries.reduce((sum, summary) => sum + summary.fairnessScore, 0);
  return roundScore(total / modeSummaries.length);
}

function computeFullMeetingScore({ fairnessScore, qualityScore, distanceMeters, radiusMeters, travelScore, safetyScore, parkingScore }) {
  const distanceScore = Number.isFinite(distanceMeters)
    ? Math.max(0, 1 - (distanceMeters / Math.max(radiusMeters, 1)))
    : 0.5;
  const normalizedFairness = Number.isFinite(travelScore)
    ? travelScore
    : Number.isFinite(fairnessScore)
      ? fairnessScore
      : 0.5;
  const normalizedSafety = Number.isFinite(safetyScore) ? safetyScore : 0.6;
  const normalizedParking = Number.isFinite(parkingScore) ? parkingScore : 0.5;

  return roundScore(
    (normalizedFairness * 0.35)
    + (qualityScore * 0.25)
    + (distanceScore * 0.15)
    + (normalizedSafety * 0.15)
    + (normalizedParking * 0.10)
  );
}

function computeSafetySignal(cafe) {
  let score = 0.62;
  const types = Array.isArray(cafe.types) ? cafe.types : [];

  if (Number(cafe.rating) >= 4.3 && (Number(cafe.user_ratings_total) || 0) >= 50) {
    score += 0.12;
  }
  if (cafe.open_now === true) {
    score += 0.06;
  }
  if (types.some((type) => ['shopping_mall', 'store', 'restaurant', 'cafe'].includes(type))) {
    score += 0.05;
  }

  return {
    score: roundScore(Math.min(score, 1)),
    confidence: 'estimated',
    factors: ['venue popularity', 'public place type', 'available Google place metadata'],
  };
}

function computeParkingSignal(cafe) {
  const text = `${cafe.name || ''} ${cafe.address || ''}`.toLowerCase();
  const types = Array.isArray(cafe.types) ? cafe.types : [];
  let score = 0.45;

  if (text.includes('parking') || text.includes('plaza') || text.includes('mall')) {
    score += 0.2;
  }
  if (types.includes('shopping_mall')) {
    score += 0.2;
  }
  if (types.includes('cafe') || types.includes('restaurant')) {
    score += 0.05;
  }

  return {
    score: roundScore(Math.min(score, 1)),
    confidence: score >= 0.65 ? 'estimated' : 'limited',
  };
}

function buildPlaceExplanation(cafe) {
  const reasons = [];

  if (Number.isFinite(cafe.distanceMeters)) {
    reasons.push(`${formatDistanceText(cafe.distanceMeters)} from the midpoint`);
  }

  if (Number.isFinite(cafe.fairnessScore) && cafe.fairnessScore >= 0.9) {
    reasons.push('very fair for both people');
  } else if (Number.isFinite(cafe.fairnessScore) && cafe.fairnessScore >= 0.75) {
    reasons.push('reasonably fair for both people');
  }

  if (Number(cafe.rating) >= 4.3) {
    reasons.push('highly rated');
  }

  if ((Number(cafe.user_ratings_total) || 0) >= 100) {
    reasons.push('well reviewed');
  }

  if (cafe.open_now === true) {
    reasons.push('currently open');
  }

  if (Number.isFinite(cafe.travelScore) && cafe.travelScore >= 0.85) {
    reasons.push('balanced by travel time');
  }

  if (cafe.parking?.score >= 0.65) {
    reasons.push('likely easier for parking');
  }

  if (reasons.length === 0) {
    return 'A nearby cafe candidate around the midpoint.';
  }

  return `Recommended because it is ${reasons.join(', ')}.`;
}

function formatDistanceText(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }

  return `${Math.round(meters)} m`;
}

// Helper: find nearby cafes around a location using Places Nearby Search
async function findNearbyCafes({ lat, lng }, radiusMeters = 1500, maxResults = 20, startCoordinates = {}) {
  const url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
  const params = {
    key: GOOGLE_MAPS_API_KEY,
    location: `${lat},${lng}`,
    radius: radiusMeters,
    type: startCoordinates.venueType || 'cafe',
    // rankby cannot be used with radius when set to distance; we keep radius to constrain area
  };

  const resp = await axios.get(url, { params, timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  if (resp.data.status !== 'OK' && resp.data.status !== 'ZERO_RESULTS') {
    throw mapGoogleStatus(resp.data.status, 'The cafe search failed. Please try again in a moment.');
  }

  const midpoint = { lat, lng };
  const results = (resp.data.results || [])
    .map((r) => {
      const location = r.geometry?.location;
      const distanceMeters = computeDistanceMeters(midpoint, location);
      const participantDistancesMeters = (startCoordinates.locations || [startCoordinates.address1, startCoordinates.address2])
        .map((coord) => computeDistanceMeters(coord, location));
      const validParticipantDistances = participantDistancesMeters.filter(Number.isFinite);
      const distanceFromAddress1Meters = participantDistancesMeters[0] ?? null;
      const distanceFromAddress2Meters = participantDistancesMeters[1] ?? null;
      const imbalanceMeters = validParticipantDistances.length >= 2
        ? Math.max(...validParticipantDistances) - Math.min(...validParticipantDistances)
        : null;
      const fairnessScore = computeFairnessScore(participantDistancesMeters);

      const cafe = {
        place_id: r.place_id,
        name: r.name,
        rating: r.rating,
        user_ratings_total: r.user_ratings_total,
        price_level: r.price_level,
        address: r.vicinity || r.formatted_address,
        location,
        radiusMeters,
        distanceMeters,
        distanceFromAddress1Meters,
        distanceFromAddress2Meters,
        participantDistancesMeters,
        imbalanceMeters,
        fairnessScore,
        open_now: r.opening_hours?.open_now,
        types: r.types,
      };
      cafe.qualityScore = computeQualityScore(cafe);
      cafe.safety = computeSafetySignal(cafe);
      cafe.parking = computeParkingSignal(cafe);
      cafe.meetingScore = computeMeetingScore({
        fairnessScore: cafe.fairnessScore,
        qualityScore: cafe.qualityScore,
        distanceMeters: cafe.distanceMeters,
        radiusMeters,
      });

      return cafe;
    })
    .sort((a, b) => {
      if (b.meetingScore !== a.meetingScore) {
        return b.meetingScore - a.meetingScore;
      }
      if (a.distanceMeters === null) {
        return 1;
      }
      if (b.distanceMeters === null) {
        return -1;
      }
      return a.distanceMeters - b.distanceMeters;
    })
    .slice(0, maxResults);

  return results;
}

async function enrichCafesWithTravel(cafes, origins, travelModes) {
  if (!GOOGLE_MAPS_API_KEY || cafes.length === 0 || origins.length === 0 || travelModes.length === 0) {
    return cafes;
  }

  const destinationCafes = cafes.filter((cafe) => isFiniteCoord(cafe.location));
  const destinations = destinationCafes.map((cafe) => cafe.location);

  if (destinations.length === 0) {
    return cafes;
  }

  for (const travelMode of travelModes) {
    const elementCount = origins.length * destinations.length;
    const maxElements = travelMode === 'transit' ? 100 : 100;
    if (elementCount > maxElements) {
      cafes.forEach((cafe) => {
        cafe.travel = cafe.travel || {};
        cafe.travel[travelMode] = {
          available: false,
          reason: `Route matrix skipped because ${elementCount} route elements exceeds the ${maxElements} element limit for this mode.`,
        };
      });
      continue;
    }

    try {
      const matrix = await getRouteMatrix(origins, destinations, travelMode);
      applyRouteMatrix(destinationCafes, matrix, travelMode);
    } catch (err) {
      cafes.forEach((cafe) => {
        cafe.travel = cafe.travel || {};
        cafe.travel[travelMode] = {
          available: false,
          reason: 'Route matrix unavailable for this search.',
        };
      });
    }
  }

  cafes.forEach((cafe) => {
    cafe.travelScore = computeTravelScore(cafe.travel);
    cafe.meetingScore = computeFullMeetingScore({
      fairnessScore: cafe.fairnessScore,
      qualityScore: cafe.qualityScore,
      distanceMeters: cafe.distanceMeters,
      radiusMeters: cafe.radiusMeters || DEFAULT_RADIUS_METERS,
      travelScore: cafe.travelScore,
      safetyScore: cafe.safety?.score,
      parkingScore: cafe.parking?.score,
    });
    cafe.whyThisPlace = buildPlaceExplanation(cafe);
  });

  return cafes.sort((a, b) => b.meetingScore - a.meetingScore);
}

async function getRouteMatrix(origins, destinations, travelMode) {
  const modeMap = {
    driving: 'DRIVE',
    transit: 'TRANSIT',
    walking: 'WALK',
  };
  const routingPreference = travelMode === 'driving' ? 'TRAFFIC_AWARE' : undefined;
  const body = {
    origins: origins.map((coord) => routeWaypoint(coord)),
    destinations: destinations.map((coord) => routeWaypoint(coord)),
    travelMode: modeMap[travelMode],
  };

  if (routingPreference) {
    body.routingPreference = routingPreference;
  }

  const resp = await axios.post(ROUTES_API_URL, body, {
    timeout: GOOGLE_REQUEST_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,status,condition',
    },
  });

  return Array.isArray(resp.data) ? resp.data : [];
}

function routeWaypoint(coord) {
  return {
    waypoint: {
      location: {
        latLng: {
          latitude: coord.lat,
          longitude: coord.lng,
        },
      },
    },
  };
}

function applyRouteMatrix(cafes, matrix, travelMode) {
  const byDestination = new Map();

  matrix.forEach((element) => {
    if (element.condition !== 'ROUTE_EXISTS' || element.status?.code) {
      return;
    }

    const destinationIndex = element.destinationIndex;
    const existing = byDestination.get(destinationIndex) || [];
    existing[element.originIndex] = {
      durationSeconds: parseDurationSeconds(element.duration),
      distanceMeters: element.distanceMeters,
    };
    byDestination.set(destinationIndex, existing);
  });

  cafes.forEach((cafe, destinationIndex) => {
    const routes = byDestination.get(destinationIndex) || [];
    const durations = routes.map((route) => route?.durationSeconds).filter(Number.isFinite);
    const distances = routes.map((route) => route?.distanceMeters).filter(Number.isFinite);
    cafe.travel = cafe.travel || {};

    if (durations.length < 2) {
      cafe.travel[travelMode] = {
        available: false,
        reason: 'Not enough routes were available to score this travel mode.',
      };
      return;
    }

    cafe.travel[travelMode] = {
      available: true,
      routes,
      averageDurationSeconds: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      maxDurationSeconds: Math.max(...durations),
      minDurationSeconds: Math.min(...durations),
      imbalanceSeconds: Math.max(...durations) - Math.min(...durations),
      averageDistanceMeters: distances.length > 0
        ? Math.round(distances.reduce((sum, value) => sum + value, 0) / distances.length)
        : null,
      fairnessScore: computeFairnessScore(durations),
    };
  });
}

function parseDurationSeconds(duration) {
  if (typeof duration !== 'string') {
    return null;
  }

  const match = duration.match(/^(\d+)s$/);
  return match ? Number(match[1]) : null;
}

app.post('/midpoint', async (req, res) => {
  try {
    const { locations, address1, address2, radiusMeters, maxResults, venueType, travelModes } = validateSearchRequest(req.body);

    const coordinatesList = await Promise.all(locations.map((location) => geocodeAddress(location)));
    const coord1 = coordinatesList[0];
    const coord2 = coordinatesList[1];

    const midpoint = computeGeographicCenter(coordinatesList);

    const cafes = await enrichCafesWithTravel(await findNearbyCafes(
      midpoint,
      radiusMeters,
      maxResults,
      { address1: coord1, address2: coord2, locations: coordinatesList, venueType }
    ), coordinatesList, travelModes);

    return res.json({
      input: { address1, address2, locations },
      options: { radiusMeters, maxResults, venueType, travelModes },
      coordinates: { address1: coord1, address2: coord2 },
      participants: locations.map((location, index) => ({
        label: `Location ${index + 1}`,
        address: location,
        coordinates: coordinatesList[index],
      })),
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
  computeFairnessScore,
  computeDistanceMeters,
  computeGeographicCenter,
  computeMidpoint,
  computeFullMeetingScore,
  computeQualityScore,
  computeMeetingScore,
  isAuthorizedApiKey,
  validateSearchRequest,
};
