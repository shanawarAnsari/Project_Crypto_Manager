import { describe, expect, it } from "vitest";
import { DeltaIndiaClient } from "../src/exchange/delta-client.js";

const config = { environment: "testnet" as const, apiKey: "test-key", apiSecret: "test-secret", productId: 84 };
const wallets = [
  { asset_symbol: "USD", balance: "6.078542095", balance_inr: "516.676078075" },
  { asset_symbol: "BTC", balance: "0.00003297", balance_inr: "220.403921925" },
  { asset_symbol: "REF_USD", balance: "0", balance_inr: "0" }
];

describe("display-only wallet portfolio valuation", () => {
  it("uses exchange INR valuations without substituting unrelated ticker prices", async () => {
    const requests: string[] = [];
    const client = new DeltaIndiaClient(config, async (input) => {
      requests.push(new URL(String(input)).pathname);
      return Response.json({ success: true, result: wallets });
    });
    const portfolio = await client.getPortfolioValuation();
    expect(portfolio).toMatchObject({
      totalUsd: "8.6715294117647058824", totalInr: "737.08",
      holdings: [
        { asset: "USD", quantity: "6.078542095", valueInr: "516.676078075", valueUsd: "6.078542095" },
        { asset: "BTC", quantity: "0.00003297", valueInr: "220.403921925" }
      ]
    });
    expect(portfolio.holdings).toHaveLength(2);
    expect(requests).toEqual(["/v2/wallet/balances"]);
  });

  it("includes INR holdings and handles empty wallets", async () => {
    const client = new DeltaIndiaClient(config, async () => Response.json({
      success: true, result: [
        { asset_symbol: "USD", balance: "1", balance_inr: "85" },
        { asset_symbol: "INR", balance: "85", balance_inr: "85" }
      ]
    }));
    expect(await client.getPortfolioValuation()).toMatchObject({ totalUsd: "2", totalInr: "170" });
    const empty = new DeltaIndiaClient(config, async () => Response.json({
      success: true, result: [{ asset_symbol: "USD", balance: "0" }]
    }));
    await expect(empty.getPortfolioValuation()).resolves.toEqual({ totalUsd: "0", totalInr: "0", holdings: [] });
  });

  it.each(["NaN", "0", "-1", "", undefined])("rejects invalid exchange INR valuation %s instead of a partial total", async (value) => {
    const client = new DeltaIndiaClient(config, async () => Response.json({
      success: true, result: [wallets[0], { asset_symbol: "BTC", balance: "0.00003297", balance_inr: value }]
    }));
    await expect(client.getPortfolioValuation()).rejects.toThrow("INR wallet valuation");
  });

  it("rejects unvalued nonzero assets instead of omitting them", async () => {
    const client = new DeltaIndiaClient(config, async () => Response.json({
      success: true, result: [...wallets, { asset_symbol: "UNKNOWN", balance: "1" }]
    }));
    await expect(client.getPortfolioValuation()).rejects.toThrow("INR wallet valuation");
  });

  it.each([
    { rows: [wallets[0], wallets[0]] },
    { rows: [wallets[1]] },
    { rows: [{ asset_symbol: "USD", balance: "invalid" }] },
    { rows: [{ asset_symbol: "../BTC", balance: "1" }] }
  ])("rejects malformed or duplicate wallets: %j", async ({ rows }) => {
    const client = new DeltaIndiaClient(config, async () => Response.json({ success: true, result: rows }));
    await expect(client.getPortfolioValuation()).rejects.toThrow();
  });
});
