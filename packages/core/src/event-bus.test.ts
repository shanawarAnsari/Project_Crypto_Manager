import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from './event-bus';

type Events = { ping: { n: number }; pong: string };

describe('InMemoryEventBus', () => {
  it('delivers payloads to subscribers of that type only', async () => {
    const bus = new InMemoryEventBus<Events>();
    const ping = vi.fn();
    const pong = vi.fn();
    bus.subscribe('ping', ping);
    bus.subscribe('pong', pong);
    await bus.publish('ping', { n: 1 });
    expect(ping).toHaveBeenCalledWith({ n: 1 });
    expect(pong).not.toHaveBeenCalled();
  });

  it('is a no-op without subscribers', async () => {
    await expect(new InMemoryEventBus<Events>().publish('pong', 'x')).resolves.toBeUndefined();
  });

  it('unsubscribes', async () => {
    const bus = new InMemoryEventBus<Events>();
    const h = vi.fn();
    const off = bus.subscribe('pong', h);
    off();
    await bus.publish('pong', 'x');
    expect(h).not.toHaveBeenCalled();
  });

  it('isolates failing handlers and reports them', async () => {
    const onError = vi.fn();
    const bus = new InMemoryEventBus<Events>(onError);
    const ok = vi.fn();
    bus.subscribe('pong', () => {
      throw new Error('boom');
    });
    bus.subscribe('pong', ok);
    await bus.publish('pong', 'x');
    expect(ok).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'pong');
  });

  it('default error handler swallows errors', async () => {
    const bus = new InMemoryEventBus<Events>();
    bus.subscribe('pong', async () => {
      throw new Error('boom');
    });
    await expect(bus.publish('pong', 'x')).resolves.toBeUndefined();
  });
});
