import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HealthCheckable, HealthReport, Logger } from '@sunny/core';

export interface HealthSnapshot {
  status: 'ok' | 'degraded' | 'down';
  checks: HealthReport[];
}

export async function collectHealth(checks: readonly HealthCheckable[]): Promise<HealthSnapshot> {
  const reports = await Promise.all(
    checks.map(async (c): Promise<HealthReport> => {
      try {
        return await c.health();
      } catch {
        return { name: c.name, status: 'down' };
      }
    }),
  );
  const status = reports.some((r) => r.status === 'down')
    ? 'down'
    : reports.some((r) => r.status === 'degraded')
      ? 'degraded'
      : 'ok';
  return { status, checks: reports };
}

/** Tiny internal HTTP endpoint, used only by the Docker healthcheck. Not published to the host. */
export class HealthServer {
  private server: Server | undefined;

  constructor(
    private readonly checks: readonly HealthCheckable[],
    private readonly log: Logger,
  ) {}

  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    this.server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/health') {
        res.writeHead(404).end();
        return;
      }
      collectHealth(this.checks).then(
        (snap) => {
          res.writeHead(snap.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify(snap));
        },
        (error: unknown) => {
          this.log.error({ err: error }, 'health collection failed');
          res.writeHead(503).end();
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, resolve);
    });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
