import { Dashboard } from '@/components/dashboard';

export default function Page() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-1 text-2xl font-semibold">Sunny Crypto Manager</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        Local dashboard · no login · bound to 127.0.0.1 only
      </p>
      <Dashboard />
    </main>
  );
}
