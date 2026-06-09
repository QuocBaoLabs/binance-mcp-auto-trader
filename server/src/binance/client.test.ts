import assert from "node:assert/strict";
import test from "node:test";
import { BinanceClient } from "./client.js";

test("trailing stop market orders use USD-M algo endpoint", async () => {
  const calls: Array<{
    method: string;
    path: string;
    params: Record<string, unknown>;
  }> = [];

  const client = new BinanceClient({
    get: () => ({})
  } as never);

  (client as unknown as {
    getSymbolRules: BinanceClient["getOrderRules"];
    request: (
      method: string,
      path: string,
      params: Record<string, unknown>
    ) => Promise<unknown>;
  }).getSymbolRules = async () => ({
    tickSize: 0.01,
    tickDecimals: 2,
    stepSize: 0.001,
    stepDecimals: 3,
    minQty: 0.001,
    marketStepSize: 0.001,
    marketStepDecimals: 3,
    marketMinQty: 0.001
  });

  (client as unknown as {
    request: (
      method: string,
      path: string,
      params: Record<string, unknown>
    ) => Promise<unknown>;
  }).request = async (method, path, params) => {
    calls.push({ method, path, params });
    return { algoId: 123, clientAlgoId: params.clientAlgoId };
  };

  await client.createOrder({
    symbol: "PAXGUSDT",
    side: "BUY",
    type: "TRAILING_STOP_MARKET",
    quantity: "0.1234",
    callbackRate: "1.5",
    activationPrice: "4470.25",
    reduceOnly: true,
    workingType: "MARK_PRICE",
    newClientOrderId: "mcp-trail-test"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/fapi/v1/algoOrder");
  assert.equal(calls[0].params.type, "TRAILING_STOP_MARKET");
  assert.equal(calls[0].params.activatePrice, "4470.25");
  assert.equal(calls[0].params.callbackRate, "1.5");
  assert.equal(calls[0].params.activationPrice, undefined);
  assert.equal(calls[0].params.clientAlgoId, "mcp-trail-test");
  assert.equal(calls[0].params.reduceOnly, true);
});
