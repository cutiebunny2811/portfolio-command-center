import test from "node:test";
import assert from "node:assert/strict";
import { makeWebullSignature } from "../supabase/functions/refresh-stock-prices/webull-signature.mjs";

test("matches Webull's published signed POST example", () => {
  assert.equal(makeWebullSignature({
    path: "/trade/place_order",
    query: { a1: "webull", a2: "123", a3: "xxx", q1: "yyy" },
    body: '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}',
    appKey: "776da210ab4a452795d74e726ebd74b6",
    appSecret: "0f50a2e853334a9aae1a783bee120c1f",
    host: "api.webull.com",
    timestamp: "2022-01-04T03:55:31Z",
    nonce: "48ef5afed43d4d91ae514aaeafbc29ba",
  }), "kvlS6opdZDhEBo5jq40nHYXaLvM=");
});

test("GET and POST produce different signatures for the same path", () => {
  const request = {
    path: "/market-data/stocks/bars/list", query: {}, appKey: "key", appSecret: "secret",
    host: "api.webull.co.th", timestamp: "2026-10-12T13:30:00Z", nonce: "nonce",
  };
  assert.notEqual(makeWebullSignature(request), makeWebullSignature({ ...request, body: '{"symbols":["QQQ"]}' }));
});
