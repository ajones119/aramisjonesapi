import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimiter } from "./rateLimiter.js";

test("fixed window allows the configured number of requests and then rejects", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ limit: 30, windowMs: 600_000, now: () => now });

  for (let index = 0; index < 30; index += 1) {
    const decision = limiter.consume("198.51.100.10");
    assert.equal(decision.allowed, true);
    assert.equal(decision.remaining, 29 - index);
  }

  const rejected = limiter.consume("198.51.100.10");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.remaining, 0);
  assert.equal(rejected.resetAt, 601_000);

  assert.equal(limiter.consume("198.51.100.11").allowed, true);
  now = 601_000;
  assert.equal(limiter.consume("198.51.100.10").allowed, true);
  assert.equal(limiter.size, 1);
});

