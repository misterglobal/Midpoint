const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clampNumber,
  computeMidpoint,
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
});

test('validateSearchRequest rejects short addresses', () => {
  assert.throws(
    () => validateSearchRequest({ address1: 'A', address2: '456 Park Ave' }),
    /Address 1 must be at least 3 characters long/
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
