import { NextResponse } from 'next/server';
import { getPrisma } from '@sunny/db';
import { computeEngineStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

const STALE_MS = Number(process.env.STALE_HEARTBEAT_MS ?? 20000);

// Read-only: the web app never writes engine state (writes go to `commands` in later prompts).
export async function GET() {
  try {
    const row = await getPrisma().engineState.findUnique({ where: { id: 1 } });
    return NextResponse.json(computeEngineStatus(row, new Date(), STALE_MS), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'database_unavailable' }, { status: 503 });
  }
}
