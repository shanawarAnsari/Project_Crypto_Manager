import { describe, expect, it } from "vitest";
import { DeltaIndiaClient } from "../src/exchange/delta-client.js";

const config = {
  environment: "testnet" as const,
  apiKey: "demo-key",
  apiSecret: "demo-secret",
  productId: 27
};

function balanceResponse() {
  return Response.json({
    success: true,
    result: [{
      asset_id: 1,
      asset_symbol: "USD",
      balance: "1000",
      available_balance: "1000",
      order_margin: "0",
      position_margin: "0"
    }]
  });
}

describe("Delta Demo daily realized PnL", () => {
  it("preserves stop-loss/target order purpose, trigger price and raw pending state", async () => {
    const orders = [
      { id: 1, stop_order_type: "stop_loss_order", stop_price: "64463.8" },
      { id: 2, stop_order_type: "take_profit_order", stop_price: "62549.1" },
      { id: 3, stop_order_type: "new_conditional_type", stop_price: "63000" },
      { id: 4, stop_order_type: null, stop_price: null },
      { id: 5, stop_order_type: "stop_loss_order" },
      { id: 6, stop_price: "62000" }
    ];
    const client = new DeltaIndiaClient(config, async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/wallet/balances")) return balanceResponse();
      if (path.endsWith("/positions/margined")) return Response.json({ result: [] });
      return Response.json({ result: orders.map((order) => ({
        ...order, product_id: 27, side: "buy", size: "1", order_type: "market_order", state: "pending"
      })), meta: { after: null } });
    });
    const result = await client.getAccountSnapshot();
    expect(result.openOrders).toMatchObject([
      { stopOrderType: "stop_loss_order", triggerPrice: "64463.8", status: "pending" },
      { stopOrderType: "take_profit_order", triggerPrice: "62549.1", status: "pending" },
      { stopOrderType: "new_conditional_type", triggerPrice: "63000", status: "pending" },
      { stopOrderType: null, triggerPrice: null },
      { stopOrderType: "stop_loss_order", triggerPrice: null },
      { stopOrderType: null, triggerPrice: "62000" }
    ]);
  });
  it.each(["invalid", "NaN", "-1", "0"])("rejects malformed or nonpositive trigger price %s", async (stop_price) => {
    const client = new DeltaIndiaClient(config, async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/wallet/balances")) return balanceResponse();
      if (path.endsWith("/positions/margined")) return Response.json({ result: [] });
      return Response.json({ result: [{ id: 1, product_id: 27, side: "buy", size: "1",
        stop_order_type: "stop_loss_order", stop_price }], meta: { after: null } });
    });
    await expect(client.getAccountSnapshot()).rejects.toThrow("trigger price");
  });
  it("uses UTC microsecond bounds and sums signed PnL ledger entries in the USD wallet unit", async () => {
    const now = Date.UTC(2026, 10, 17, 18, 30);
    const requests: URL[] = [];
    const client = new DeltaIndiaClient(config, async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("/wallet/balances")) return balanceResponse();
      return Response.json({
        success: true,
        result: [
          { id: 1, amount: "12.5", balance: "1012.5", transaction_type: "cashflow", asset_id: 1, asset_symbol: "USD", created_at: "exchange-timestamp" },
          { id: 2, amount: "-0.5", balance: "1012", transaction_type: "commission", asset_id: 1, asset_symbol: "USD", created_at: "exchange-timestamp" },
          { id: 3, amount: "-0.1", balance: "1011.9", transaction_type: "funding", asset_id: 1, asset_symbol: "USD", created_at: "exchange-timestamp" },
          { id: 4, amount: "100", balance: "1111.9", transaction_type: "deposit", asset_id: 1, asset_symbol: "USD", created_at: "exchange-timestamp" }
        ],
        meta: { after: null, before: null }
      });
    });

    await expect(client.getDailyRealizedPnl(now)).resolves.toBe("11.9");

    const query = requests.find((url) => url.pathname.endsWith("/wallet/transactions"));
    expect(query?.searchParams.get("asset_ids")).toBe("1");
    expect(query?.searchParams.get("start_time")).toBe(String(Date.UTC(2026, 10, 17) * 1000));
    expect(query?.searchParams.get("end_time")).toBe(String(now * 1000));
  });

  it("follows after cursors and accepts a full final page with the documented null cursor", async () => {
    const requests: URL[] = [];
    const client = new DeltaIndiaClient(config, async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("/wallet/balances")) return balanceResponse();
      if (url.searchParams.get("after") === "next") {
        return Response.json({
          success: true,
          result: [{
            id: 51, amount: "-1", balance: "999", transaction_type: "cashflow",
            asset_id: 1, asset_symbol: "USD", created_at: "exchange-timestamp"
          }],
          meta: { after: null, before: "previous" }
        });
      }
      const page = Array.from({ length: 50 }, (_, index) => ({
        id: index + 1,
        amount: "-1",
        balance: "1000",
        transaction_type: "cashflow",
        asset_id: 1,
        asset_symbol: "USD",
        created_at: "exchange-timestamp"
      }));
      return Response.json({ success: true, result: page, meta: { after: "next", before: null } });
    });

    await expect(client.getDailyRealizedPnl(Date.UTC(2026, 10, 17, 10))).resolves.toBe("-51");
    expect(requests.filter((url) => url.pathname.endsWith("/wallet/transactions"))).toHaveLength(2);

    const fullFinalPage = new DeltaIndiaClient(config, async (input) => {
      if (String(input).includes("/wallet/balances")) return balanceResponse();
      return Response.json({
        success: true,
        result: Array.from({ length: 50 }, (_, index) => ({
          id: index + 1, amount: "1", balance: "1000", transaction_type: "cashflow",
          asset_id: 1, asset_symbol: "USD", created_at: "exchange-timestamp"
        })),
        meta: { after: null, before: "previous" }
      });
    });
    await expect(fullFinalPage.getDailyRealizedPnl(Date.UTC(2026, 10, 17, 10))).resolves.toBe("50");

    const incomplete = new DeltaIndiaClient(config, async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/wallet/balances")) return balanceResponse();
      return Response.json({
        success: true,
        result: Array.from({ length: 50 }, (_, index) => ({
          id: index + 1,
          amount: "1",
          balance: "1000",
          transaction_type: "cashflow",
          asset_id: 1,
          asset_symbol: "USD",
          created_at: "exchange-timestamp"
        })),
        meta: { before: null }
      });
    });
    await expect(incomplete.getDailyRealizedPnl(Date.UTC(2026, 10, 17, 10)))
      .rejects.toThrow("pagination metadata was missing");
  });

  it("rejects unknown transaction types and malformed PnL amounts instead of returning a partial total", async () => {
    const response = (result: unknown) => new DeltaIndiaClient(config, async (input) => {
      if (String(input).includes("/wallet/balances")) return balanceResponse();
      return Response.json({ success: true, result, meta: { after: null, before: null } });
    });
    await expect(response([{
      id: 1, amount: "10", balance: "1010", transaction_type: "new_exchange_pnl_type",
      asset_id: 1, asset_symbol: "USD", created_at: "exchange-timestamp"
    }]).getDailyRealizedPnl(Date.UTC(2026, 10, 17, 10))).rejects.toThrow("unsupported wallet transaction type");
    await expect(response([{
      id: 1, amount: "not-a-decimal", balance: "1010", transaction_type: "cashflow",
      asset_id: 1, asset_symbol: "USD", created_at: "exchange-timestamp"
    }]).getDailyRealizedPnl(Date.UTC(2026, 10, 17, 10))).rejects.toThrow("transaction amount");
  });
});
