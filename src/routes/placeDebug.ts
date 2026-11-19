import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { PlaceIdentity, PlaceModel } from "../place/placeModel.js";
import { authenticateVisitor, hashNetwork } from "../place/visitorCookie.js";

/**
 * Development-only routes for the /place debug panel: see what the server
 * knows about you, change the Cooldown length, and reset your Cooldown.
 * Register them only when NODE_ENV is development; they bypass the Cooldown.
 */
export async function registerPlaceDebugRoutes(app: FastifyInstance, config: Config, model: PlaceModel): Promise<void> {
  function identify(request: FastifyRequest, reply: FastifyReply): PlaceIdentity | undefined {
    const visitorHash = authenticateVisitor(request.headers.cookie ?? null, config.placeCookieSecret);
    if (!visitorHash) {
      void reply.code(401).send({ error: "invalid_visitor" });
      return;
    }
    return { visitorHash, networkHash: hashNetwork(request.ip, config.placeCookieSecret) };
  }

  const status = (identity: PlaceIdentity) => ({ ...identity, ...model.cooldownStatus(identity) });
  const schema = { tags: ["place-debug"], hide: true };

  app.get("/place/debug", { schema: { ...schema, summary: "What the server knows about this visitor" } }, async (request, reply) => {
    const identity = identify(request, reply);
    if (identity) return status(identity);
  });

  app.post(
    "/place/debug/cooldown",
    {
      schema: {
        ...schema,
        summary: "Set the Cooldown length for later Placements",
        body: z.object({ seconds: z.number().int().min(0).max(86_400) }),
      },
    },
    async (request, reply) => {
      const identity = identify(request, reply);
      if (!identity) return;
      model.setCooldownSeconds((request.body as { seconds: number }).seconds);
      return status(identity);
    },
  );

  app.post("/place/debug/reset", { schema: { ...schema, summary: "End this visitor's Cooldown" } }, async (request, reply) => {
    const identity = identify(request, reply);
    if (!identity) return;
    model.resetCooldown(identity);
    return status(identity);
  });
}
