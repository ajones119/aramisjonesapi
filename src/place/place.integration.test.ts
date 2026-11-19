import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, type Room } from "@colyseus/sdk";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import type { CanvasSnapshot } from "./placeModel.js";

function newDataDir() {
  return mkdtempSync(join(tmpdir(), "place-test-"));
}

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
  placeAdminToken: undefined,
  placeDataDir: newDataDir(),
  supabaseUrl: "http://127.0.0.1:1",
  supabasePublishableKey: "test-key",
} satisfies Config;

const R_PLACE_2017_PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
];

/** Boots the API. Each call gets an empty data folder unless one is passed, so Canvases never leak between tests. */
async function startApi(
  runtimeConfig: Config = testConfig,
  now: () => number = Date.now,
  placeDataDir = newDataDir(),
) {
  const app = await buildApp({ ...runtimeConfig, placeDataDir }, { logger: false, now });
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

interface DebugStatus {
  visitorHash: string;
  networkHash: string;
  cooldownSeconds: number;
  nextAllowedAt: number;
  serverNow: number;
  networkPlacements: number;
  networkCap: number;
}

async function debugRequest(endpoint: string, cookie: string | undefined, method: string, path: string, body?: unknown) {
  const response = await fetch(`${endpoint}/place/debug${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: response.status === 404 ? undefined : await response.json() as DebugStatus };
}

test("in development the debug routes show what the server sees about the visitor", async () => {
  const now = 1_700_000_000_000;
  const { app, endpoint } = await startApi({ ...testConfig, placeCooldownSeconds: 600, placeNetworkCap: 4 }, () => now);
  try {
    const { room, cookie } = await joinVisitor(endpoint);
    const before = await debugRequest(endpoint, cookie, "GET", "");
    assert.equal(before.status, 200);
    assert.match(before.body!.visitorHash, /^[0-9a-f]{64}$/);
    assert.match(before.body!.networkHash, /^[0-9a-f]{64}$/);
    assert.equal(before.body!.visitorHash.includes(cookie.split("=")[1].split(".")[0]), false);
    assert.deepEqual(
      { ...before.body, visitorHash: undefined, networkHash: undefined },
      { visitorHash: undefined, networkHash: undefined, cooldownSeconds: 600, nextAllowedAt: now, serverNow: now, networkPlacements: 0, networkCap: 4 },
    );

    const accepted = nextMessage(room, "place:accepted");
    room.send("place", { x: 1, y: 1, color: 3 });
    await accepted;
    const after = await debugRequest(endpoint, cookie, "GET", "");
    assert.equal(after.body!.nextAllowedAt, now + 600_000);
    assert.equal(after.body!.networkPlacements, 1);
    assert.equal(after.body!.visitorHash, before.body!.visitorHash);

    assert.equal((await debugRequest(endpoint, undefined, "GET", "")).status, 401);
    await room.leave();
  } finally {
    await app.close();
  }
});

test("in development the Cooldown length can be changed for later Placements and a visitor's Cooldown reset", async () => {
  const now = 1_700_000_000_000;
  const { app, endpoint } = await startApi({ ...testConfig, placeCooldownSeconds: 600, placeNetworkCap: 1 }, () => now);
  try {
    const { room, cookie } = await joinVisitor(endpoint);
    const first = nextMessage(room, "place:accepted");
    room.send("place", { x: 1, y: 1, color: 3 });
    await first;

    const shortened = await debugRequest(endpoint, cookie, "POST", "/cooldown", { seconds: 5 });
    assert.equal(shortened.status, 200);
    assert.equal(shortened.body!.cooldownSeconds, 5);
    assert.equal(shortened.body!.nextAllowedAt, now + 600_000, "the running Cooldown is unchanged");

    const reset = await debugRequest(endpoint, cookie, "POST", "/reset");
    assert.equal(reset.status, 200);
    assert.equal(reset.body!.nextAllowedAt, now);
    assert.equal(reset.body!.networkPlacements, 0, "reset also clears this network's window");

    const second = nextMessage<{ nextAllowedAt: number; serverNow: number }>(room, "place:accepted");
    room.send("place", { x: 2, y: 1, color: 3 });
    assert.deepEqual(await second, { nextAllowedAt: now + 5_000, serverNow: now });

    await debugRequest(endpoint, cookie, "POST", "/cooldown", { seconds: 0 });
    await debugRequest(endpoint, cookie, "POST", "/reset");
    const third = nextMessage<{ nextAllowedAt: number }>(room, "place:accepted");
    room.send("place", { x: 3, y: 1, color: 3 });
    assert.equal((await third).nextAllowedAt, now);

    for (const seconds of [-1, 1.5, "10"]) {
      assert.equal((await debugRequest(endpoint, cookie, "POST", "/cooldown", { seconds })).status, 400);
    }
    await room.leave();
  } finally {
    await app.close();
  }
});

test("debug routes do not exist in production", async () => {
  const app = await buildApp({ ...testConfig, nodeEnv: "production" }, { logger: false });
  try {
    const session = await app.inject({ method: "POST", url: "/place/session" });
    const cookie = `${session.cookies[0].name}=${session.cookies[0].value}`;
    for (const [method, url, payload] of [
      ["GET", "/place/debug", undefined],
      ["POST", "/place/debug/cooldown", { seconds: 0 }],
      ["POST", "/place/debug/reset", undefined],
    ] as const) {
      const response = await app.inject({ method, url, headers: { cookie }, payload });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
    }
  } finally {
    await app.close();
  }
});

const ADMIN_TOKEN = "test-admin-token-0123456789";

interface HistoryEntry {
  x: number;
  y: number;
  color: number;
  previousColor: number;
  visitorHash: string;
  networkHash: string;
  at: number;
}

async function admin(app: Awaited<ReturnType<typeof buildApp>>, method: "GET" | "POST", url: string, payload?: unknown, token = ADMIN_TOKEN) {
  return app.inject({ method, url, payload: payload as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

async function visitorHashOf(endpoint: string, cookie: string) {
  return (await debugRequest(endpoint, cookie, "GET", "")).body!.visitorHash;
}

async function placeAndWait(room: Room, x: number, y: number, color: number) {
  const accepted = nextMessage(room, "place:accepted");
  room.send("place", { x, y, color });
  await accepted;
}

test("the Placement History keeps the latest 5,000 Placements, newest first", async () => {
  let now = 1_700_000_000_000;
  const { app, endpoint } = await startApi({ ...testConfig, placeAdminToken: ADMIN_TOKEN, placeNetworkCap: 100_000 }, () => now++);
  try {
    const { room, cookie } = await joinVisitor(endpoint);
    const visitorHash = await visitorHashOf(endpoint, cookie);
    const total = 5_001;
    let accepted = 0;
    const allAccepted = new Promise<void>(resolve => room.onMessage("place:accepted", () => {
      if (++accepted === total) resolve();
    }));
    for (let i = 0; i < total; i++) room.send("place", { x: i % 128, y: Math.floor(i / 128), color: (i % 15) + 1 });
    await allAccepted;

    const response = await admin(app, "GET", "/place/admin/placements?limit=5000");
    assert.equal(response.statusCode, 200);
    const { placements } = response.json() as { placements: HistoryEntry[] };
    assert.equal(placements.length, 5_000);
    assert.deepEqual(
      { ...placements[0], at: 0, networkHash: "" },
      { x: 5_000 % 128, y: Math.floor(5_000 / 128), color: (5_000 % 15) + 1, previousColor: 0, visitorHash, networkHash: "", at: 0 },
    );
    const oldest = placements.at(-1)!;
    assert.deepEqual([oldest.x, oldest.y], [1, 0], "the very first Placement was evicted");
    assert.ok(placements[0].at > oldest.at);
    assert.match(oldest.networkHash, /^[0-9a-f]{64}$/);

    const limited = (await admin(app, "GET", "/place/admin/placements?limit=3")).json() as { placements: HistoryEntry[] };
    assert.equal(limited.placements.length, 3);
    assert.equal((await admin(app, "GET", "/place/admin/placements?limit=5001")).statusCode, 400);
    await room.leave();
  } finally {
    await app.close();
  }
});

test("revert restores only Pixels where the visitor is still on top, broadcasts them, and records them", async () => {
  let now = 1_700_000_000_000;
  const { app, endpoint } = await startApi({ ...testConfig, placeAdminToken: ADMIN_TOKEN }, () => now);
  const rooms: Room[] = [];
  try {
    const vandal = await joinVisitor(endpoint);
    const friend = await joinVisitor(endpoint);
    const watcher = await joinVisitor(endpoint);
    rooms.push(vandal.room, friend.room, watcher.room);
    const vandalHash = await visitorHashOf(endpoint, vandal.cookie);

    await placeAndWait(friend.room, 9, 9, 10);    // the friend's art: (9,9) is green
    now += 1_000;
    const from = now;
    await placeAndWait(vandal.room, 1, 1, 5);     // (1,1) white -> red
    await placeAndWait(vandal.room, 1, 1, 3);     // (1,1) red -> black, same vandal
    await placeAndWait(vandal.room, 2, 2, 5);     // (2,2) white -> red, fixed by the friend below
    await placeAndWait(vandal.room, 9, 9, 3);     // (9,9) green -> black
    now += 1_000;
    await placeAndWait(friend.room, 2, 2, 12);    // the friend fixes (2,2)
    const to = now;
    now += 60_000;
    await placeAndWait(vandal.room, 4, 4, 5);     // outside the range: stays

    const restoredPixels: { x: number; y: number; color: number }[] = [];
    watcher.room.onMessage("placed", (message: { x: number; y: number; color: number }) => restoredPixels.push(message));
    const response = await admin(app, "POST", "/place/admin/revert", { visitorHash: vandalHash, from, to });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { restored: 2 });

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(
      restoredPixels.sort((a, b) => a.x - b.x),
      [{ x: 1, y: 1, color: 0 }, { x: 9, y: 9, color: 10 }],
    );

    const rejoin = await joinVisitor(endpoint);
    rooms.push(rejoin.room);
    const colorAt = (x: number, y: number) => {
      const index = y * 128 + x;
      const byte = rejoin.canvas.pixels[index >> 1];
      return index & 1 ? byte & 0x0f : byte >> 4;
    };
    assert.deepEqual([colorAt(1, 1), colorAt(2, 2), colorAt(9, 9), colorAt(4, 4)], [0, 12, 10, 5]);

    const { placements } = (await admin(app, "GET", "/place/admin/placements?limit=2")).json() as { placements: HistoryEntry[] };
    assert.deepEqual(placements.map(entry => entry.visitorHash), ["admin", "admin"]);
    assert.deepEqual(
      placements.map(({ x, y, color, previousColor }) => ({ x, y, color, previousColor })).sort((a, b) => a.x - b.x),
      [{ x: 1, y: 1, color: 0, previousColor: 3 }, { x: 9, y: 9, color: 10, previousColor: 3 }],
    );

    const filtered = (await admin(app, "GET", `/place/admin/placements?limit=50&visitorHash=${vandalHash}`)).json() as { placements: HistoryEntry[] };
    assert.equal(filtered.placements.length, 5);
    assert.ok(filtered.placements.every(entry => entry.visitorHash === vandalHash));
  } finally {
    await Promise.all(rooms.map(room => room.leave()));
    await app.close();
  }
});

test("admin routes reject a missing or wrong token", async () => {
  const app = await buildApp({ ...testConfig, placeAdminToken: ADMIN_TOKEN }, { logger: false });
  try {
    for (const token of ["", "wrong", ADMIN_TOKEN.replace(/.$/, "x")]) {
      assert.equal((await admin(app, "GET", "/place/admin/placements", undefined, token)).statusCode, 401, `token "${token}"`);
      assert.equal((await admin(app, "POST", "/place/admin/revert", { visitorHash: "a".repeat(64) }, token)).statusCode, 401);
    }
    assert.equal((await admin(app, "GET", "/place/admin/placements")).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("admin routes do not exist without PLACE_ADMIN_TOKEN", async () => {
  const app = await buildApp({ ...testConfig, placeAdminToken: undefined }, { logger: false });
  try {
    assert.equal((await admin(app, "GET", "/place/admin/placements")).statusCode, 404);
    assert.equal((await admin(app, "POST", "/place/admin/revert", { visitorHash: "a".repeat(64) })).statusCode, 404);
  } finally {
    await app.close();
  }
});

function colorAt(canvas: CanvasSnapshot, x: number, y: number) {
  const index = y * 128 + x;
  const byte = canvas.pixels[index >> 1];
  return index & 1 ? byte & 0x0f : byte >> 4;
}

test("the Canvas and Placement History survive a restart, but Cooldowns do not", async () => {
  const dataDir = newDataDir();
  const now = 1_700_000_000_000;
  const config = { ...testConfig, placeCooldownSeconds: 600, placeAdminToken: ADMIN_TOKEN };

  const first = await startApi(config, () => now, dataDir);
  let cookie: string;
  try {
    const visitor = await joinVisitor(first.endpoint);
    cookie = visitor.cookie;
    await placeAndWait(visitor.room, 3, 0, 5);  // high nibble of byte 1
    const other = await joinVisitor(first.endpoint);
    await placeAndWait(other.room, 127, 127, 13); // low nibble of the last byte
    await Promise.all([visitor.room.leave(), other.room.leave()]);
  } finally {
    await first.app.close();
  }
  assert.deepEqual(readdirSync(dataDir), ["place.json"], "saved by rename, with no temp file left behind");

  const second = await startApi(config, () => now, dataDir);
  try {
    const { room, canvas } = await joinVisitor(second.endpoint, { cookie: cookie! });
    assert.equal(colorAt(canvas, 3, 0), 5);
    assert.equal(colorAt(canvas, 127, 127), 13);
    assert.equal(canvas.pixels.filter(byte => byte !== 0).length, 2);
    assert.equal(canvas.nextAllowedAt, now, "the Cooldown was cleared by the restart");

    const { placements } = (await admin(second.app, "GET", "/place/admin/placements")).json() as { placements: HistoryEntry[] };
    assert.deepEqual(placements.map(({ x, y, color, previousColor, at }) => ({ x, y, color, previousColor, at })), [
      { x: 127, y: 127, color: 13, previousColor: 0, at: now },
      { x: 3, y: 0, color: 5, previousColor: 0, at: now },
    ]);

    // History restored from disk still drives revert.
    const revert = await admin(second.app, "POST", "/place/admin/revert", { visitorHash: placements[1].visitorHash });
    assert.deepEqual(revert.json(), { restored: 1 });
    await room.leave();
  } finally {
    await second.app.close();
  }
});

test("an unchanged Canvas is not rewritten on shutdown", async () => {
  const dataDir = newDataDir();
  const { app } = await startApi(testConfig, Date.now, dataDir);
  await app.close();
  assert.deepEqual(readdirSync(dataDir), []);
});

test("a corrupt save file is kept aside and Place boots with an empty Canvas", async () => {
  const wrongShape = JSON.stringify({ version: 1, width: 128, height: 128, pixels: "AAAA", history: [] });
  for (const contents of ["{ not json", wrongShape]) {
    const dataDir = newDataDir();
    writeFileSync(join(dataDir, "place.json"), contents);
    const { app, endpoint } = await startApi(testConfig, Date.now, dataDir);
    try {
      const { room, canvas } = await joinVisitor(endpoint);
      assert.ok(canvas.pixels.every(byte => byte === 0));
      await room.leave();
    } finally {
      await app.close();
    }
    const files = readdirSync(dataDir);
    const kept = files.find(name => name.startsWith("place.json.corrupt-"));
    assert.ok(kept, `corrupt file kept aside: ${files.join(", ")}`);
    assert.equal(readFileSync(join(dataDir, kept), "utf8"), contents);
  }
});
