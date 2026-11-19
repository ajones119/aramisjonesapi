import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { refreshVisitorCookie } from "../place/visitorCookie.js";

export async function registerPlaceSessionRoute(app: FastifyInstance, config: Config): Promise<void> {
  const attributes = `; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${config.nodeEnv === "production" ? "; Secure" : ""}`;
  app.post(
    "/place/session",
    { schema: { tags: ["place"], summary: "Issue or refresh the anonymous Place visitor cookie" } },
    async (request, reply) => {
      const cookie = refreshVisitorCookie(request.headers.cookie, config.placeCookieSecret);
      return reply.header("Set-Cookie", cookie + attributes).header("Cache-Control", "no-store").code(204).send();
    },
  );
}
