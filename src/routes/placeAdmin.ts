import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HISTORY_CAPACITY, type PlaceModel } from "../place/placeModel.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Owner-only Place routes: list the Placement History and revert a visitor's
 * Placements. Register them only when PLACE_ADMIN_TOKEN is set; every request
 * must send it as `Authorization: Bearer <token>`. There is no admin UI.
 */
export async function registerPlaceAdminRoutes(app: FastifyInstance, adminToken: string, model: PlaceModel): Promise<void> {
  const expected = digest(adminToken);

  await app.register(async (scope) => {
    scope.addHook("onRequest", async (request, reply) => {
      const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
      // Compare fixed-length digests so neither the token nor its length leaks through timing.
      if (!match || !timingSafeEqual(digest(match[1]), expected)) {
        return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized" });
      }
    });

    scope.get(
      "/place/admin/placements",
      {
        schema: {
          tags: ["place-admin"],
          hide: true,
          summary: "Recent Placements, newest first",
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(HISTORY_CAPACITY).default(100),
            visitorHash: z.string().regex(/^[0-9a-f]{64}$|^admin$/).optional(),
          }),
        },
      },
      async (request) => {
        const { limit, visitorHash } = request.query as { limit: number; visitorHash?: string };
        return { placements: model.listPlacements({ limit, visitorHash }) };
      },
    );

    scope.post(
      "/place/admin/revert",
      {
        schema: {
          tags: ["place-admin"],
          hide: true,
          summary: "Revert a visitor's Placements in a time range (epoch ms, inclusive)",
          body: z.object({
            visitorHash: z.string().regex(/^[0-9a-f]{64}$/),
            from: z.number().int().min(0).default(0),
            to: z.number().int().min(0).default(Number.MAX_SAFE_INTEGER),
          }),
        },
      },
      async (request) => {
        const { visitorHash, from, to } = request.body as { visitorHash: string; from: number; to: number };
        return { restored: model.revert(visitorHash, from, to).length };
      },
    );
  });
}
