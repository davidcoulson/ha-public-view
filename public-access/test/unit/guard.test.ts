import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Flood, RateLimiter, SessionLimiter, visitorAddress } from '../../src/http/guard.ts';

test('a private peer is a proxy: CF-Connecting-IP names the visitor', () => {
  assert.equal(visitorAddress('172.30.33.4', { 'cf-connecting-ip': '203.0.113.9' }), '203.0.113.9');
  assert.equal(visitorAddress('::ffff:172.30.33.4', { 'cf-connecting-ip': '2001:db8::1' }), '2001:db8::1');
});

test('without CF header, the last X-Forwarded-For entry (added by our own proxy) is used', () => {
  assert.equal(visitorAddress('10.0.0.5', { 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }), '198.51.100.7');
});

test('a public peer connected directly: forwarded headers are ignored because they can be forged', () => {
  assert.equal(visitorAddress('198.51.100.20', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }), '198.51.100.20');
});

test('garbage in headers falls back to the peer address', () => {
  assert.equal(visitorAddress('172.30.33.4', { 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'also, bad' }), '172.30.33.4');
  assert.equal(visitorAddress(undefined, {}), 'unknown');
});

test('rate limiter counts per key per minute', () => {
  let now = 0;
  const rl = new RateLimiter(3, () => now);
  assert.deepEqual([1, 2, 3, 4].map(() => rl.allow('a')), [true, true, true, false]);
  assert.equal(rl.allow('b'), true);
  now = 61_000;
  assert.equal(rl.allow('a'), true);
});

test('session limiter enforces the total and the per-visitor cap, and release frees a slot once', () => {
  const sl = new SessionLimiter(3, 2);
  const a1 = sl.acquire('a'); const a2 = sl.acquire('a');
  assert.ok(a1 && a2);
  assert.equal(sl.acquire('a'), null);
  const b1 = sl.acquire('b');
  assert.ok(b1);
  assert.equal(sl.acquire('c'), null);
  a1!(); a1!();
  assert.equal(sl.active, 2);
  assert.ok(sl.acquire('c'));
});

test('flood detector trips only above the limit inside the window', () => {
  let now = 0;
  const f = new Flood(3, 1000, () => now);
  assert.deepEqual([f.hit(), f.hit(), f.hit(), f.hit()], [true, true, true, false]);
  now = 2000;
  assert.equal(f.hit(), true);
});
