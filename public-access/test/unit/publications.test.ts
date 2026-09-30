import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicationStore, ValidationError, validatePublications } from '../../src/publications.ts';

const ok = { hostname: 'Solar.Example.com', dashboard: 'energy', view: 'solar' };

test('valid input is cleaned: host lowercased, defaults applied', () => {
  assert.deepEqual(validatePublications([{ ...ok, title: '  Solar  ' }]), [{ hostname: 'solar.example.com', dashboard: 'energy', view: 'solar', title: 'Solar', noindex: true, enabled: true }]);
  assert.equal(validatePublications([{ ...ok, view: 12345 }])[0].view, '12345');
  assert.equal(validatePublications([{ ...ok, noindex: false }])[0].noindex, false);
});

test('bad input gets a message the owner can act on', () => {
  const bad = (x: unknown, re: RegExp) => assert.throws(() => validatePublications(x), (e: Error) => e instanceof ValidationError && re.test(e.message));
  bad('x', /list/);
  bad([{ ...ok, hostname: 'not a host' }], /not a valid host name/);
  bad([{ ...ok, hostname: 'https://x.com' }], /not a valid host name/);
  bad([{ ...ok, dashboard: '' }], /choose a dashboard/);
  bad([{ ...ok, view: '' }], /choose a view/);
  bad([ok, ok], /used twice/);
  bad([{ ...ok, title: 'x'.repeat(81) }], /80 characters/);
});

test('store saves atomically, reloads from disk, and tells listeners', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pa-'));
  const store = await PublicationStore.load(dir, [{ hostname: 'seed.example.com', dashboard: 'd', view: 'v', noindex: true }]);
  assert.equal(store.list()[0].hostname, 'seed.example.com');
  let changed = 0;
  store.onChange(() => changed++);
  await store.set([ok]);
  assert.equal(changed, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'publications.json'), 'utf8'))[0].hostname, 'solar.example.com');
  const again = await PublicationStore.load(dir, []);
  assert.equal(again.list()[0].hostname, 'solar.example.com');
  await assert.rejects(store.set([{ hostname: '' }]), ValidationError);
  assert.equal(store.list()[0].hostname, 'solar.example.com');
});
