import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { Session } from '../../src/relay/session.ts';
import { published } from './helpers.ts';

const STATES = [{ entity_id: 'sensor.temp', state: '20' }, { entity_id: 'lock.secret', state: 'locked' }];

/** A stand-in Core that answers get_states with a private entity in it, batching replies when told to. */
async function rig(coalesce: boolean) {
  const core = new WebSocketServer({ port: 0 });
  let coreConnections = 0;
  core.on('connection', (ws) => {
    coreConnections++;
    ws.send(JSON.stringify({ type: 'auth_required' }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'auth') return ws.send(JSON.stringify({ type: 'auth_ok' }));
      const replies = [{ id: m.id, type: 'result', success: true, result: m.type === 'get_states' ? STATES : null }];
      ws.send(JSON.stringify(coalesce ? [...replies, { id: 999, type: 'result', success: true, result: STATES }] : replies[0]));
    });
  });
  const front = new WebSocketServer({ port: 0 });
  const pub = { hostname: 'h', dashboard: 'public-test', view: 'solar', noindex: true };
  front.on('connection', (ws) => {
    new Session(ws, pub, { get: async () => published() } as never, { accessToken: async () => 't' } as never, `http://127.0.0.1:${(core.address() as AddressInfo).port}`, 100, () => undefined);
  });
  const visitor = new WebSocket(`ws://127.0.0.1:${(front.address() as AddressInfo).port}`);
  const got: any[] = [];
  visitor.on('message', (raw) => got.push(JSON.parse(raw.toString())));
  await once(visitor, 'open');
  const settle = () => new Promise((r) => setTimeout(r, 150));
  return { visitor, got, settle, coreConnections: () => coreConnections, stop: () => { visitor.terminate(); front.close(); core.close(); } };
}

const leaked = (got: unknown[]) => JSON.stringify(got).includes('lock.secret');

test('a reused id cannot relabel a reply to skip its filter, and auth opens one upstream', async () => {
  const r = await rig(false);
  r.visitor.send(JSON.stringify({ type: 'auth', access_token: 'x' }));
  r.visitor.send(JSON.stringify({ type: 'auth', access_token: 'x' }));
  r.visitor.send(JSON.stringify([{ id: 1, type: 'get_states' }, { id: 1, type: 'ping' }]));
  await r.settle();
  try {
  assert.equal(leaked(r.got), false);
  assert.equal(r.got.find((m) => m.id === 1 && m.success === true).result.length, 1);
  assert.equal(r.got.some((m) => m.error?.code === 'id_reuse'), true);
  assert.equal(r.coreConnections(), 1);
  } finally { r.stop(); }
});

test('batched replies from Core are filtered one by one, and unasked ones dropped', async () => {
  const r = await rig(true);
  r.visitor.send(JSON.stringify({ type: 'auth', access_token: 'x' }));
  r.visitor.send(JSON.stringify({ id: 1, type: 'get_states' }));
  await r.settle();
  try {
  assert.equal(leaked(r.got), false);
  assert.deepEqual(r.got.find((m) => m.id === 1).result, [STATES[0]]);
  } finally { r.stop(); }
});
