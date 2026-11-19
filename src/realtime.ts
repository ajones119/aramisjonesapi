import { createAuthContext, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { PlaceModel } from "./place/placeModel.js";
import { createPlaceRoom, PLACE_ROOM } from "./place/placeRoom.js";

/** Room names visitors may join. Rooms are created by the server, never by matchmaking requests. */
const PUBLIC_ROOMS = [PLACE_ROOM] as const;
const JOIN_METHODS = ["join", "joinById", "reconnect"] as const;

/**
 * Runs Colyseus inside this Fastify app (ADR-0001): websocket upgrades go to the
 * Colyseus transport on Fastify's own HTTP server, and matchmaking is a Fastify
 * route so CORS and validation stay in one place.
 */
export async function registerRealtime(
  app: FastifyInstance,
  config: Config,
  placeModel: PlaceModel,
): Promise<void> {
  const transport = new WebSocketTransport({
    noServer: true,
    // Compress large messages (the Canvas sent on join, mostly empty or flat
    // color) without spending CPU on the small per-Placement ones. No context
    // takeover keeps per-connection memory small.
    perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
    beforeUpgrade: (_request, context) => {
      // Same rule as the HTTP CORS check: browsers always send Origin, so only a
      // non-browser client (tests, scripts) arrives without one. Cooldown, not
      // origin, is what limits scripts.
      const origin = context.headers.get("origin");
      if (origin && !config.corsOrigins.includes(origin)) {
        return new Response("Origin is not allowed", { status: 403 });
      }
    },
  });
  transport.attachToServer(app.server);

  await matchMaker.setup();
  matchMaker.defineRoomType(PLACE_ROOM, createPlaceRoom(placeModel, config.placeCookieSecret));
  await matchMaker.accept();
  await matchMaker.createRoom(PLACE_ROOM, {});

  app.post(
    "/matchmake/:method/:roomName",
    {
      schema: {
        params: z.object({ method: z.enum(JOIN_METHODS), roomName: z.enum(PUBLIC_ROOMS) }),
        body: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (request, reply) => {
      const { method, roomName } = request.params as { method: (typeof JOIN_METHODS)[number]; roomName: string };
      try {
        const authContext = createAuthContext({
          headers: request.headers as Record<string, string>,
          remoteAddress: request.ip,
        });
        // Fastify has already applied TRUST_PROXY; do not let Colyseus reinterpret
        // untrusted forwarding headers a second time.
        authContext.ip = request.ip;
        return await matchMaker.controller.invokeMethod(
          method,
          roomName,
          (request.body as Record<string, unknown> | undefined) ?? {},
          authContext,
        );
      } catch (error) {
        const code = (error as { code?: number }).code;
        return reply
          .code(matchMaker.controller.getHttpStatus(code ?? 500))
          .send({ code, error: (error as Error).message });
      }
    },
  );

  app.addHook("onClose", async () => {
    await matchMaker.gracefullyShutdown().catch(() => undefined);
    transport.shutdown();
  });
}
