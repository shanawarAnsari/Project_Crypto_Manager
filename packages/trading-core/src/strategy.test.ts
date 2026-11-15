import { describe, expect, it } from 'vitest';
import { isWarmedUp, type Candle, type Strategy } from './index';

const candle: Candle = {
  openTime: new Date(0),
  open: '1',
  high: '1',
  low: '1',
  close: '1',
  volume: '1',
};
const strategy: Strategy = { id: 's', warmUpCandles: 2, onCandleClosed: () => null };

describe('isWarmedUp', () => {
  it('requires the declared number of candles', () => {
    const ctx = { symbol: 'BTCUSD', timeframe: '1h' as const, candles: [candle] };
    expect(isWarmedUp(strategy, ctx)).toBe(false);
    expect(isWarmedUp(strategy, { ...ctx, candles: [candle, candle] })).toBe(true);
  });
});
