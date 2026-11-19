import assert from "node:assert/strict";
import test from "node:test";
import { TimedCache } from "./timedCache.js";

test("timed cache returns values until the TTL expires", () => {
  let now = 1_000;
  const cache = new TimedCache<string>({ ttlMs: 600_000, maxEntries: 500, now: () => now });

  cache.set("scene", "result");
  assert.equal(cache.get("scene"), "result");
  now = 601_000;
  assert.equal(cache.get("scene"), undefined);
});

test("timed cache evicts the oldest entry at its configured capacity", () => {
  const cache = new TimedCache<number>({ ttlMs: 600_000, maxEntries: 2 });

  cache.set("one", 1);
  cache.set("two", 2);
  cache.set("three", 3);

  assert.equal(cache.get("one"), undefined);
  assert.equal(cache.get("two"), 2);
  assert.equal(cache.get("three"), 3);
});

