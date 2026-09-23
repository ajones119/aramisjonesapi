import type { FastifyInstance } from "fastify";
import { z } from "zod";

const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        tags: ["system"],
        summary: "Health check",
        response: { 200: healthResponseSchema },
      },
    },
    async () => ({ status: "ok" as const }),
  );
}
