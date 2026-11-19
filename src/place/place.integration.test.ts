import assert from "node:assert/strict";
import test from "node:test";
import { Client, type Room } from "@colyseus/sdk";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import type { CanvasSnapshot } from "./placeModel.js";

const testConfig = {
  nodeEnv: "development",
  port: 0,
  host: "127.0.0.1",
  trustProxy: false,
  corsOrigins: ["http://localhost:4321"],
  typesafeApiKey: "test-key",
  placeCookieSecret: "test-place-secret",
  placeCooldownSeconds: 0,
  placeNetworkCap: 100,
  supabaseUrl: "http://127.0.0.1:1",
  supabasePublishableKey: "test-key",
} satisfies Config;

const R_PLACE_2017_PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
];

async function startApi(
  runtimeConfig: Config = testConfig,
  now: () => number = Date.now,
) {
  const app = await buildApp(runtimeConfig, { logger: false, now });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("API did not bind a port");
  return { app, endpoint: `http://127.0.0.1:${address.port}` };
}

async function sessionCookie(endpoint: string, previous?: string) {
  const response = await fetch(`${endpoint}/place/session`, {
    method: "POST",
    headers: previous ? { Cookie: previous } : {},
  });
  assert.equal(response.status, 204);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  assert.match(cookie, /;\s*HttpOnly\b/i);
  assert.match(cookie, /;\s*SameSite=Lax\b/i);
  return cookie.split(";", 1)[0];
}

async function joinVisitor(
  endpoint: string,
  { cookie: existingCookie, headers = {} }: { cookie?: string; headers?: Record<string, string> } = {},
) {
  const cookie = existingCookie ?? await sessionCookie(endpoint);
  const room = await new Client(endpoint, { headers: { ...headers, Cookie: cookie } }).join("place");
  const canvas = await nextMessage<CanvasSnapshot>(room, "canvas");
  return { room, canvas, cookie };
}

function nextMessage<T>(room: { onMessage: (type: string, cb: (message: T) => void) => () => void }, type: string) {
  return new Promise<T>(resolve => {
    const off = room.onMessage(type, message => {
      off();
      resolve(message);
    });
  });
}

test("a visitor joining Place receives the Palette and an all-white 128×128 Canvas", async () => {
  const { app, endpoint } = await startApi();
  try {
    const { room, canvas } = await joinVisitor(endpoint);

    assert.deepEqual(canvas.palette, R_PLACE_2017_PALETTE);
    assert.equal(canvas.width, 128);
    assert.equal(canvas.height, 128);
    assert.equal(canvas.pixels.byteLength, 8192);
    assert.ok(canvas.pixels.every((byte) => byte === 0), "every Pixel is Palette index 0 (white)");

    await room.leave();
  } finally {
    await app.close();
  }
});

test("missing and tampered visitor cookies cannot join; a session refresh keeps the visitor id", async () => {
  const { app, endpoint } = await startApi();
  try {
    const cookie = await sessionCookie(endpoint);
    assert.equal(await sessionCookie(endpoint, cookie), cookie);
    assert.notEqual(await sessionCookie(endpoint), cookie);
    for (const token of [undefined, cookie + "x"]) {
      const client = new Client(endpoint, token ? { headers: { Cookie: token } } : {});
      await assert.rejects(client.join("place"), { code: 401, message: "invalid_visitor" });
    }
  } finally {
    await app.close();
  }
});

test("the production session cookie is secure and never exposed in the body", async () => {
  const app = await buildApp({ ...testConfig, nodeEnv: "production" }, { logger: false });
  try {
    const response = await app.inject({ method: "POST", url: "/place/session" });
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");
    assert.equal(response.cookies.length, 1);
    assert.equal(response.cookies[0].secure, true);
    assert.equal(response.cookies[0].httpOnly, true);
  } finally {
    await app.close();
  }
});

test("visitors see each accepted Placement and a fresh join gets the latest packed Canvas", async () => {
  const { app, endpoint } = await startApi();
  try {
    const { room: first } = await joinVisitor(endpoint);
    const { room: second } = await joinVisitor(endpoint);
    for (const [placer, x, color] of [[first, 0, 1], [second, 1, 3], [second, 0, 5]] as const) {
      const pixel = { x, y: 0, color };
      const replies = Promise.all([
        nextMessage<{ nextAllowedAt: number; serverNow: number }>(placer, "place:accepted"),
        nextMessage(first, "placed"), nextMessage(second, "placed"),
      ]);
      placer.send("place", pixel);
      const [ack, a, b] = await replies;
      assert.ok(Number.isFinite(ack.serverNow) && ack.nextAllowedAt <= ack.serverNow);
      assert.deepEqual(a, pixel);
      assert.deepEqual(b, pixel);
    }
    const { room, canvas } = await joinVisitor(endpoint);
    assert.equal(canvas.pixels[0], 0x53);
    await Promise.all([first.leave(), second.leave(), room.leave()]);
  } finally {
    await app.close();
  }
});

test("a visitor's Cooldown survives reload and expires according to the server clock", async () => {
  let now = 1_700_000_000_000;
  const { app, endpoint } = await startApi(
    { ...testConfig, placeCooldownSeconds: 600 },
    () => now,
  );
  try {
    const firstVisit = await joinVisitor(endpoint);
    assert.equal(firstVisit.canvas.serverNow, now);
    assert.equal(firstVisit.canvas.nextAllowedAt, now);

    const accepted = nextMessage<{ nextAllowedAt: number; serverNow: number }>(
      firstVisit.room,
      "place:accepted",
    );
    firstVisit.room.send("place", { x: 4, y: 5, color: 6 });
    assert.deepEqual(await accepted, { nextAllowedAt: now + 600_000, serverNow: now });
    await firstVisit.room.leave();

    const reload = await joinVisitor(endpoint, { cookie: firstVisit.cookie });
    assert.equal(reload.canvas.serverNow, now);
    assert.equal(reload.canvas.nextAllowedAt, now + 600_000);

    const rejected = nextMessage<{ reason: string; nextAllowedAt: number; serverNow: number }>(
      reload.room,
      "place:rejected",
    );
    reload.room.send("place", { x: 5, y: 5, color: 6 });
    assert.deepEqual(await rejected, {
      reason: "cooldown",
      nextAllowedAt: now + 600_000,
      serverNow: now,
    });

    now += 600_000;
    const afterExpiry = nextMessage<{ nextAllowedAt: number; serverNow: number }>(
      reload.room,
      "place:accepted",
    );
    reload.room.send("place", { x: 5, y: 5, color: 6 });
    assert.deepEqual(await afterExpiry, { nextAllowedAt: now + 600_000, serverNow: now });
    await reload.room.leave();
  } finally {
    await app.close();
  }
});

test("one network can make only four Placements per Cooldown window", async () => {
  const now = 1_700_000_000_000;
  const { app, endpoint } = await startApi(
    { ...testConfig, placeCooldownSeconds: 600, placeNetworkCap: 4 },
    () => now,
  );
  const rooms: Room[] = [];
  try {
    for (let visitor = 0; visitor < 5; visitor++) {
      const { room } = await joinVisitor(endpoint, {
        // TRUST_PROXY is false: these untrusted values must not create new networks.
        headers: { "x-forwarded-for": `192.0.2.${visitor + 1}` },
      });
      rooms.push(room);
    }

    for (let visitor = 0; visitor < 4; visitor++) {
      const accepted = nextMessage<{ nextAllowedAt: number; serverNow: number }>(
        rooms[visitor],
        "place:accepted",
      );
      rooms[visitor].send("place", { x: visitor, y: 10, color: visitor + 1 });
      assert.deepEqual(await accepted, { nextAllowedAt: now + 600_000, serverNow: now });
    }

    const rejected = nextMessage<{ reason: string; nextAllowedAt: number; serverNow: number }>(
      rooms[4],
      "place:rejected",
    );
    rooms[4].send("place", { x: 4, y: 10, color: 5 });
    assert.deepEqual(await rejected, {
      reason: "network_cap",
      nextAllowedAt: now + 600_000,
      serverNow: now,
    });
  } finally {
    await Promise.all(rooms.map(room => room.leave()));
    await app.close();
  }
});

test("IPv6 visitors in the same /64 share the network cap", async () => {
  const now = 1_700_000_000_000;
  const { app, endpoint } = await startApi(
    {
      ...testConfig,
      trustProxy: true,
      placeCooldownSeconds: 600,
      placeNetworkCap: 2,
    },
    () => now,
  );
  const rooms: Room[] = [];
  try {
    for (const ip of [
      "2001:db8:1234:5678::1",
      "2001:0db8:1234:5678:abcd::2",
      "2001:db8:1234:5678:ffff::3",
    ]) {
      const { room } = await joinVisitor(endpoint, { headers: { "x-forwarded-for": ip } });
      rooms.push(room);
    }

    for (let visitor = 0; visitor < 2; visitor++) {
      const accepted = nextMessage(rooms[visitor], "place:accepted");
      rooms[visitor].send("place", { x: visitor, y: 11, color: 1 });
      await accepted;
    }

    const rejected = nextMessage<{ reason: string }>(rooms[2], "place:rejected");
    rooms[2].send("place", { x: 2, y: 11, color: 1 });
    assert.equal((await rejected).reason, "network_cap");
  } finally {
    await Promise.all(rooms.map(room => room.leave()));
    await app.close();
  }
});

test("invalid Placements return a reason without changing or broadcasting a Pixel", async () => {
  const { app, endpoint } = await startApi();
  try {
    const { room: placer } = await joinVisitor(endpoint);
    const updates: unknown[] = [];
    placer.onMessage("placed", message => updates.push(message));
    for (const [x, y, color, reason] of [
      [-1, 1, 5, "out_of_bounds"], [128, 0, 5, "out_of_bounds"], [0, 128, 5, "out_of_bounds"],
      [1.5, 0, 5, "out_of_bounds"], [1, 0, 16, "bad_color"], [1, 0, -1, "bad_color"],
      [1, 0, 1.5, "bad_color"], [1, 0, "5", "bad_color"],
    ] as const) {
      const reply = nextMessage<{ reason: string }>(placer, "place:rejected");
      placer.send("place", { x, y, color });
      assert.equal((await reply).reason, reason);
    }
    const { room, canvas } = await joinVisitor(endpoint);
    assert.ok(canvas.pixels.every(byte => byte === 0));
    assert.deepEqual(updates, []);
    await Promise.all([placer.leave(), room.leave()]);
  } finally {
    await app.close();
  }
});

test("the portfolio can make credentialed matchmaking requests", async () => {
  const { app } = await startApi();
  try {
    const origin = "http://localhost:4321";
    const response = await app.inject({
      method: "OPTIONS",
      url: "/matchmake/join/place",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-origin"], origin);
    assert.equal(response.headers["access-control-allow-credentials"], "true");
  } finally {
    await app.close();
  }
});

test("a websocket from an origin outside CORS_ORIGINS is refused before it connects", async () => {
  const { app, endpoint } = await startApi();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${endpoint.replace("http", "ws")}/any/room`, {
        headers: { origin: "https://evil.example" },
      });
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.on("open", () => reject(new Error("socket opened")));
      socket.on("error", () => undefined);
    });
    assert.equal(status, 403);
  } finally {
    await app.close();
  }
});

test("matchmaking cannot create extra rooms", async () => {
  const { app } = await startApi();
  try {
    const response = await app.inject({ method: "POST", url: "/matchmake/create/place", payload: {} });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});
