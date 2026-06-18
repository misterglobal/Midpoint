const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clampNumber,
  computeFairnessScore,
  computeDistanceMeters,
  computeFullMeetingScore,
  computeGeographicCenter,
  computeMidpoint,
  computeMeetingScore,
  computeQualityScore,
  validateSearchRequest,
} = require('./app');

test('validateSearchRequest normalizes addresses and clamps numeric options', () => {
  const result = validateSearchRequest({
    address1: '  123   Main St  ',
    address2: '  456 Park Ave  ',
    radiusMeters: 90000,
    maxResults: 100,
  });

  assert.equal(result.address1, '123 Main St');
  assert.equal(result.address2, '456 Park Ave');
  assert.equal(result.radiusMeters, 50000);
  assert.equal(result.maxResults, 60);
  assert.deepEqual(result.travelModes, ['driving']);
});

test('validateSearchRequest accepts two or more locations and travel modes', () => {
  const result = validateSearchRequest({
    locations: [' Toronto, ON ', ' Mississauga, ON ', ' Markham, ON '],
    travelModes: ['driving', 'transit', 'flying', 'walking'],
    venueType: ' Restaurant ',
  });

  assert.deepEqual(result.locations, ['Toronto, ON', 'Mississauga, ON', 'Markham, ON']);
  assert.deepEqual(result.travelModes, ['driving', 'transit', 'walking']);
  assert.equal(result.venueType, 'restaurant');
});

test('validateSearchRequest rejects short addresses', () => {
  assert.throws(
    () => validateSearchRequest({ address1: 'A', address2: '456 Park Ave' }),
    /Location 1 must be at least 3 characters long/
  );
});

test('clampNumber falls back for invalid values', () => {
  assert.equal(clampNumber('not a number', 1500, 100, 50000), 1500);
  assert.equal(clampNumber(25, 1500, 100, 50000), 100);
  assert.equal(clampNumber(60000, 1500, 100, 50000), 50000);
});

test('computeMidpoint returns the midpoint between nearby coordinates', () => {
  const midpoint = computeMidpoint(
    { lat: 40.7128, lng: -74.0060 },
    { lat: 42.3601, lng: -71.0589 }
  );

  assert.ok(Math.abs(midpoint.lat - 41.545) < 0.1);
  assert.ok(Math.abs(midpoint.lng - -72.550) < 0.1);
});

test('computeGeographicCenter supports more than two coordinates', () => {
  const center = computeGeographicCenter([
    { lat: 43.6532, lng: -79.3832 },
    { lat: 43.5890, lng: -79.6441 },
    { lat: 43.8561, lng: -79.3370 },
  ]);

  assert.ok(center.lat > 43.6);
  assert.ok(center.lat < 43.8);
  assert.ok(center.lng < -79.3);
  assert.ok(center.lng > -79.6);
});

test('computeDistanceMeters returns geographic distance in meters', () => {
  const distance = computeDistanceMeters(
    { lat: 43.6532, lng: -79.3832 },
    { lat: 43.6542, lng: -79.3832 }
  );

  assert.ok(distance >= 110);
  assert.ok(distance <= 112);
});

test('computeDistanceMeters returns null for invalid coordinates', () => {
  assert.equal(computeDistanceMeters({ lat: 43.6532 }, { lat: 43.6542, lng: -79.3832 }), null);
});

test('computeFairnessScore rewards balanced distance from both people', () => {
  assert.equal(computeFairnessScore(1000, 1000), 1);
  assert.equal(computeFairnessScore(1000, 1500), 0.67);
  assert.equal(computeFairnessScore(null, 1500), null);
});

test('computeQualityScore considers rating, review count, and open status', () => {
  const strongCafe = computeQualityScore({
    rating: 4.8,
    user_ratings_total: 250,
    open_now: true,
  });
  const weakCafe = computeQualityScore({
    rating: 3.2,
    user_ratings_total: 2,
    open_now: false,
  });

  assert.ok(strongCafe > weakCafe);
});

test('computeMeetingScore balances fairness, quality, and midpoint distance', () => {
  const stronger = computeMeetingScore({
    fairnessScore: 0.95,
    qualityScore: 0.9,
    distanceMeters: 100,
    radiusMeters: 1000,
  });
  const weaker = computeMeetingScore({
    fairnessScore: 0.55,
    qualityScore: 0.6,
    distanceMeters: 900,
    radiusMeters: 1000,
  });

  assert.ok(stronger > weaker);
});

test('computeFullMeetingScore includes travel, safety, and parking signals', () => {
  const stronger = computeFullMeetingScore({
    fairnessScore: 0.7,
    qualityScore: 0.9,
    travelScore: 0.95,
    safetyScore: 0.9,
    parkingScore: 0.8,
    distanceMeters: 100,
    radiusMeters: 1000,
  });
  const weaker = computeFullMeetingScore({
    fairnessScore: 0.7,
    qualityScore: 0.5,
    travelScore: 0.45,
    safetyScore: 0.4,
    parkingScore: 0.3,
    distanceMeters: 900,
    radiusMeters: 1000,
  });

  assert.ok(stronger > weaker);
});
