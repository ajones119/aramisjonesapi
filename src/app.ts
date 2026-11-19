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
import { registerSoundscapeRoute } from "./routes/soundscape.js";

export async function buildApp(runtimeConfig: Config = config) {
  const app = Fastify({ logger: true, trustProxy: runtimeConfig.trustProxy }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
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
  await registerSoundscapeRoute(app, runtimeConfig);
  if (runtimeConfig.nodeEnv !== "production") {
    await registerJevRoute(app, runtimeConfig);
  }

  return app;
}
