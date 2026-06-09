import assert from "node:assert/strict";
import test from "node:test";
import { OrderExecutor } from "./order-executor.js";
import type { RuntimeSettings } from "../types.js";

function makeExecutor() {
  const settings: Partial<RuntimeSettings> = {
    dryRun: true
  };
  const settingsService = {
    get: () => settings
  };
  const db = {
    insertOrder: () => undefined
  };
  const risk = {
    assertProtectedTrade: () => undefined
  };
  const audit = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };

  return new OrderExecutor(
    settingsService as never,
    {} as never,
    db as never,
    risk as never,
    audit as never
  );
}

function clearPendingProtectionTimers(executor: OrderExecutor) {
  const timers = (executor as unknown as {
    pendingProtectionTimers?: Map<string, ReturnType<typeof setTimeout>>;
  }).pendingProtectionTimers;
  if (!timers) return;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

async function dryRunEntryTimeInForce(postOnly?: boolean) {
  const executor = makeExecutor();
  const result = await executor.executeProtectedTrade({
    symbol: "BTCUSDT",
    side: "BUY",
    entryType: "LIMIT",
    quantity: 0.01,
    entryPrice: 100,
    stopLossPrice: 99,
    takeProfitPrice: 102,
    leverage: 1,
    postOnly,
    source: "dashboard"
  }) as { orders: Array<{ timeInForce?: string }> };

  return result.orders[0]?.timeInForce;
}

test("post-only protected limit entries use GTX", async () => {
  assert.equal(await dryRunEntryTimeInForce(true), "GTX");
});

test("protected limit entries default to GTC", async () => {
  assert.equal(await dryRunEntryTimeInForce(), "GTC");
});

test("limit entries do not pre-check protective triggers before the entry fills", async () => {
  let getPriceCalls = 0;
  let createOrderCalls = 0;
  const settings: Partial<RuntimeSettings> = {
    dryRun: false
  };
  const executor = new OrderExecutor(
    { get: () => settings } as never,
    {
      getPosition: async () => [{ symbol: "BTCUSDT", positionAmt: "0" }],
      changeMarginType: async () => ({}),
      getBalance: async () => [{ asset: "USDT", availableBalance: "1000" }],
      getMaxLeverage: async () => 20,
      changeLeverage: async () => ({}),
      getPrice: async () => {
        getPriceCalls += 1;
        return { price: "99" };
      },
      createOrder: async () => {
        createOrderCalls += 1;
        return { orderId: createOrderCalls };
      }
    } as never,
    { insertOrder: () => undefined } as never,
    { assertProtectedTrade: () => undefined } as never,
    {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as never
  );

  try {
    const result = await executor.executeProtectedTrade({
      symbol: "BTCUSDT",
      side: "BUY",
      entryType: "LIMIT",
      quantity: 0.01,
      entryPrice: 100,
      stopLossPrice: 99,
      takeProfitPrice: 102,
      leverage: 1,
      source: "dashboard"
    }) as { stopLoss: { status: string }; takeProfit: { status: string } };

    assert.equal(getPriceCalls, 0);
    assert.equal(createOrderCalls, 1);
    assert.equal(result.stopLoss.status, "PENDING_POSITION");
    assert.equal(result.takeProfit.status, "PENDING_POSITION");
  } finally {
    clearPendingProtectionTimers(executor);
  }
});
