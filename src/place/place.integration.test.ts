import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@colyseus/sdk";
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
  supabaseUrl: "http://127.0.0.1:1",
  supabasePublishableKey: "test-key",
} satisfies Config;

const R_PLACE_2017_PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
];

async function startApi() {
  const app = await buildApp(testConfig, { logger: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("API did not bind a port");
  return { app, endpoint: `http://127.0.0.1:${address.port}` };
}

function nextMessage<T>(room: { onMessage: (type: string, cb: (message: T) => void) => unknown }, type: string) {
  return new Promise<T>((resolve) => room.onMessage(type, resolve));
}

test("a visitor joining Place receives the Palette and an all-white 128×128 Canvas", async () => {
  const { app, endpoint } = await startApi();
  try {
    const client = new Client(endpoint);
    const room = await client.join("place");
    const canvas = await nextMessage<CanvasSnapshot>(room, "canvas");

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
