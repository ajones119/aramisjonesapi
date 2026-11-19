import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Config } from "../config.js";
import { registerSoundscapeRoute } from "./soundscape.js";

test("resolver rate limit rejects the 31st request before upstream work", async () => {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerSoundscapeRoute(app, {
    nodeEnv: "development",
    port: 4322,
    host: "127.0.0.1",
    trustProxy: false,
    corsOrigins: [],
    placeCookieSecret: "test-place-secret",
    placeCooldownSeconds: 600,
    placeNetworkCap: 4,
    typesafeApiKey: "test-key",
    supabaseUrl: "http://127.0.0.1:1",
    supabasePublishableKey: "test-key",
  } satisfies Config);

  try {
    const request = {
      method: "POST" as const,
      url: "/api/soundscape/resolve",
      payload: { sceneDescription: "a quiet tavern", limits: { music: 1 } },
    };

    for (let index = 0; index < 30; index += 1) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 503);
    }

    const limited = await app.inject(request);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["x-ratelimit-limit"], "30");
    assert.equal(limited.headers["x-ratelimit-remaining"], "0");
    assert.ok(limited.headers["retry-after"]);
  } finally {
    await app.close();
  }
});
