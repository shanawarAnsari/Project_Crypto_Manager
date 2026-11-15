import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@sunny/core';
import { HealthServer, collectHealth } from './health.server';

const log = createLogger({ level: 'silent' });
const ok = { name: 'a', health: async () => ({ name: 'a', status: 'ok' as const }) };
const degraded = { name: 'b', health: async () => ({ name: 'b', status: 'degraded' as const }) };
const down = { name: 'c', health: async () => ({ name: 'c', status: 'down' as const }) };
const throwing = {
  name: 't',
  health: async () => {
    throw new Error('x');
  },
};

describe('collectHealth', () => {
  it('aggregates worst status', async () => {
    expect((await collectHealth([ok])).status).toBe('ok');
    expect((await collectHealth([ok, degraded])).status).toBe('degraded');
    expect((await collectHealth([ok, degraded, down])).status).toBe('down');
  });

  it('treats a throwing check as down', async () => {
    const snap = await collectHealth([throwing]);
    expect(snap.status).toBe('down');
    expect(snap.checks[0]).toEqual({ name: 't', status: 'down' });
  });
});

describe('HealthServer', () => {
  let server: HealthServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('returns 200 when healthy and 503 when not', async () => {
    server = new HealthServer([ok], log);
    const port = await server.listen(0, '127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
    await server.close();

    server = new HealthServer([ok, down], log);
    const port2 = await server.listen(0, '127.0.0.1');
    expect((await fetch(`http://127.0.0.1:${port2}/health`)).status).toBe(503);
  });

  it('returns 404 for other paths and methods', async () => {
    server = new HealthServer([ok], log);
    const port = await server.listen(0, '127.0.0.1');
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' })).status).toBe(404);
  });

  it('close() is idempotent', async () => {
    server = new HealthServer([ok], log);
    await server.close();
    await server.listen(0, '127.0.0.1');
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
