import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { config, type Config } from "./config.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerJevRoute } from "./routes/jev.js";
import { registerPlaceSessionRoute } from "./routes/placeSession.js";
import { registerSoundscapeRoute } from "./routes/soundscape.js";
import { registerRealtime } from "./realtime.js";

export interface BuildAppOptions {
  logger?: boolean;
  now?: () => number;
}

export async function buildApp(
  runtimeConfig: Config = config,
  { logger = true, now = Date.now }: BuildAppOptions = {},
) {
  const app = Fastify({ logger, trustProxy: runtimeConfig.trustProxy }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || runtimeConfig.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS"), false);
    },
  });

  if (runtimeConfig.nodeEnv !== "production") {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Aramis Jones API",
          description: "Development API for reusable side-project infrastructure.",
          version: "0.1.0",
        },
        servers: [{ url: `http://${runtimeConfig.host}:${runtimeConfig.port}` }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: "validation error",
        issues: error.validation,
      });
    }
    request.log.error({ err: error }, "Unhandled request failure");
    return reply.send(error);
  });

  await registerHealthRoute(app);
  await registerPlaceSessionRoute(app, runtimeConfig);
  await registerSoundscapeRoute(app, runtimeConfig);
  await registerRealtime(app, runtimeConfig, now);
  if (runtimeConfig.nodeEnv !== "production") {
    await registerJevRoute(app, runtimeConfig);
  }

  return app;
}
