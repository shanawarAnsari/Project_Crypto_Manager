'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { formatAge, type EngineStatus } from '@/lib/status';

async function fetchStatus(): Promise<EngineStatus> {
  const res = await fetch('/api/status', { cache: 'no-store' });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as EngineStatus;
}

export function Dashboard() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['engine-status'],
    queryFn: fetchStatus,
    refetchInterval: 2000,
  });

  if (isLoading) return <p role="status">Loading…</p>;

  if (error || !data) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-300"
      >
        Cannot read the database. The engine state is unknown — treat trading as halted.
      </div>
    );
  }

  const levelBadge =
    data.level === 'ok' ? (
      <Badge variant="ok">Engine alive</Badge>
    ) : data.level === 'stale' ? (
      <Badge variant="danger">Heartbeat stale</Badge>
    ) : (
      <Badge variant="warn">Engine offline</Badge>
    );

  return (
    <div className="space-y-4">
      {data.level !== 'ok' && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-300"
        >
          {data.level === 'stale'
            ? `Engine heartbeat is stale (${formatAge(data.heartbeatAgeMs)} old). Data below may be outdated.`
            : 'No engine heartbeat has been recorded yet.'}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>Engine</CardTitle>
          <div className="flex items-center gap-2">{levelBadge}</div>
          <dl className="mt-3 space-y-1 text-sm">
            <Row label="Last heartbeat" value={data.heartbeatAt ?? '—'} />
            <Row label="Heartbeat age" value={formatAge(data.heartbeatAgeMs)} />
            <Row
              label="Clock offset"
              value={data.clockOffsetMs === null ? '—' : `${data.clockOffsetMs} ms`}
            />
            <Row label="Instance" value={data.instanceId ?? '—'} />
          </dl>
        </Card>
        <Card>
          <CardTitle>Mode &amp; safety</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Badge variant={data.mode === 'LIVE' ? 'danger' : 'ok'}>{data.mode}</Badge>
            <Badge variant={data.killSwitch ? 'danger' : 'ok'}>
              Kill switch {data.killSwitch ? 'ON' : 'off'}
            </Badge>
            <Badge variant={data.tradingEnabled ? 'ok' : 'neutral'}>
              Trading {data.tradingEnabled ? 'enabled' : 'disabled'}
            </Badge>
          </div>
          <p className="mt-3 text-sm text-[var(--muted)]">
            Foundation build: the engine is idle and places no orders.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className="truncate font-mono">{value}</dd>
    </div>
  );
}
