"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeGeckoOhlcv, loadNaraPriceHistories } = require("./src/historical-prices");
const { tokenAddressKey } = require("./src/uniswap-v4");

const HOUR_MS = 3600000;
const from = Date.parse("2026-10-01T00:00:00Z");
const to = from + 720 * HOUR_MS;
const address = (id) => "0x" + id.toString(16).padStart(40, "0");
const candidate = (id = 1, chain = "BASE") => ({ chain, address: address(id), primary_pool_address: address(id + 100) });
const rows = () => Array.from({ length: 720 }, (_, index) => [from / 1000 + index * 3600, 100, 101, 99, 100, index === 0 ? 0 : 1000]);
const payload = (token, candles = rows()) => ({ data: { attributes: { ohlcv_list: candles } }, meta: { base: { address: token }, quote: { address: address(999) } } });
const response = (data) => ({ ok: true, status: 200, json: async () => data });

test("OHLCV normalization sorts/deduplicates and rejects corrupt rows without inventing candles", () => {
  const valid = rows().slice(0, 3);
  const result = normalizeGeckoOhlcv(payload(address(1), [valid[2], valid[0], valid[1], valid[1],
    [from / 1000 + 10800, 0, 1, 0, 1, 5], [from / 1000 + 14400, 100, 99, 98, 100, 5],
    [from / 1000 + 18000, 100, 101, 99, 100, -1], [null, 100, 101, 99, 100, 5]]));
  assert.equal(result.length, 3);
  assert.equal(result[0].at, from);
  assert.equal(result[0].volumeUsd, 0, "provider-supplied zero-volume marks remain explicit");
  assert.equal(result[2].at, from + 2 * HOUR_MS);
  assert.throws(() => normalizeGeckoOhlcv({ data: {} }), /Format respons/);
});

test("request uses USD token-address orientation and excludes the unfinished current hour", async () => {
  const token = candidate();
  let request;
  const result = await loadNaraPriceHistories([token], { from, to }, async (url, options) => {
    request = new URL(url);
    assert.equal(options.headers.accept, "application/json;version=20230203");
    assert(options.signal instanceof AbortSignal);
    return response(payload(token.address.toUpperCase(), [[to / 1000, 100, 101, 99, 100, 1000], ...rows().reverse()]));
  });
  assert.equal(request.host, "api.geckoterminal.com");
  assert.equal(request.searchParams.get("aggregate"), "1");
  assert.equal(request.searchParams.get("limit"), "1000");
  assert.equal(request.searchParams.get("before_timestamp"), String(to / 1000 - 1));
  assert.equal(request.searchParams.get("currency"), "usd");
  assert.equal(request.searchParams.get("token"), token.address);
  assert.equal(request.searchParams.get("include_empty_intervals"), "true");
  assert.equal(result[0].key, tokenAddressKey(token.chain, token.address));
  assert.equal(result[0].candles.length, 720);
  assert.equal(result[0].candles.at(-1).at, to - HOUR_MS);
});

test("both HyperEVM and Arc use their verified GeckoTerminal network slugs", async () => {
  const requested = [];
  const result = await loadNaraPriceHistories([candidate(2, "HYPEREVM"), candidate(3, "ARC")], { from, to }, async (url) => {
    const parsed = new URL(url);
    requested.push(parsed.pathname);
    return response(payload(parsed.searchParams.get("token")));
  });
  assert(requested.some((url) => url.includes("/networks/hyperevm/")));
  assert(requested.some((url) => url.includes("/networks/arc/")));
  assert(result.every((item) => item.error === null && item.candles.length === 720));
});

test("quote chart must identify the requested token as meta.base, not just as a pool member", async () => {
  const token = candidate();
  const result = await loadNaraPriceHistories([token], { from, to }, async () => response({
    ...payload(address(2)), meta: { base: { address: address(2) }, quote: { address: token.address } },
  }));
  assert.equal(result[0].candles.length, 0);
  assert.match(result[0].error, /Identitas token/);
});

test("partial and stale coverage is returned as-is rather than locally forward-filled", async () => {
  const token = candidate();
  const result = await loadNaraPriceHistories([token], { from, to }, async () => response(payload(token.address, rows().slice(4, -2))));
  assert.equal(result[0].candles.length, 714);
  assert.equal(result[0].candles[0].at, from + 4 * HOUR_MS);
  assert.equal(result[0].candles.at(-1).at, to - 3 * HOUR_MS);
});

test("backward pagination uses the oldest timestamp minus one and deduplicates overlap", async () => {
  const token = candidate();
  const all = rows();
  const requested = [];
  const result = await loadNaraPriceHistories([token], { from, to }, async (url) => {
    requested.push(Number(new URL(url).searchParams.get("before_timestamp")));
    const candles = requested.length === 1
      ? Array.from({ length: 1000 }, (_, index) => all[500 + index % 220])
      : Array.from({ length: 1000 }, (_, index) => all[index % 500]);
    return response(payload(token.address, candles));
  });
  assert.deepEqual(requested, [to / 1000 - 1, (from + 500 * HOUR_MS) / 1000 - 1]);
  assert.equal(result[0].candles.length, 720);
});

test("invalid pools/unsupported chains fail closed without making network requests", async () => {
  let calls = 0;
  const result = await loadNaraPriceHistories([{ ...candidate(), primary_pool_address: "../../other-host" }, candidate(2, "UNSUPPORTED")], { from, to }, async () => { calls++; });
  assert.equal(calls, 0);
  assert(result.every((item) => item.error && !item.candles.length));
});

test("HTTP failures and aborts report unavailable history, never substitute random prices", async () => {
  for (const status of [401, 404, 429, 503]) {
    const result = await loadNaraPriceHistories([candidate()], { from, to }, async () => ({ ok: false, status }));
    assert.equal(result[0].candles.length, 0);
    assert.match(result[0].error, new RegExp(String(status)));
  }
  const result = await loadNaraPriceHistories([candidate()], { from, to }, async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
  assert.match(result[0].error, /Timeout/);
});

test("history requests are bounded to two concurrent candidates", async () => {
  let active = 0;
  let maximum = 0;
  const result = await loadNaraPriceHistories([1, 2, 3, 4, 5].map((id) => candidate(id)), { from, to }, async (url) => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return response(payload(new URL(url).searchParams.get("token")));
  });
  assert.equal(result.length, 5);
  assert.equal(maximum, 2);
});

test("successful/in-flight requests share the production cache", async () => {
  const nativeFetch = global.fetch;
  const token = candidate(20);
  let calls = 0;
  global.fetch = async () => { calls++; await Promise.resolve(); return response(payload(token.address)); };
  try {
    const results = await Promise.all([loadNaraPriceHistories([token], { from, to }), loadNaraPriceHistories([token], { from, to })]);
    assert.equal(calls, 1);
    assert(results.every((result) => result[0].candles.length === 720));
    await loadNaraPriceHistories([token], { from, to });
    assert.equal(calls, 1);
  } finally {
    global.fetch = nativeFetch;
  }
});
