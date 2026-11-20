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
import { createPlaceModel } from "./place/placeModel.js";
import { diskBackend, loadPlace, startPlaceSaver } from "./place/placeStore.js";
import { supabaseBackend } from "./place/supabaseSaveBackend.js";
import { registerPlaceAdminRoutes } from "./routes/placeAdmin.js";
import { registerPlaceDebugRoutes } from "./routes/placeDebug.js";
import { registerPlaceSessionRoute } from "./routes/placeSession.js";
import { registerSoundscapeRoute } from "./routes/soundscape.js";
import { registerRealtime } from "./realtime.js";

export interface BuildAppOptions {
  logger?: boolean;
  now?: () => number;
  /** Startup read retry budget; short windows keep integration tests fast. */
  placeReadRetryMs?: number;
  placeSaveIntervalMs?: number;
}

export async function buildApp(
  runtimeConfig: Config = config,
  { logger = true, now = Date.now, placeReadRetryMs = 60_000, placeSaveIntervalMs }: BuildAppOptions = {},
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
  const placeBackend = runtimeConfig.supabaseSecretKey
    ? supabaseBackend(runtimeConfig.supabaseUrl, runtimeConfig.supabaseSecretKey)
    : diskBackend(runtimeConfig.placeDataDir, now);
  let saved;
  try {
    saved = await loadPlace(placeBackend, app.log, runtimeConfig.supabaseSecretKey ? placeReadRetryMs : 0);
  } catch (error) {
    await app.close();
    throw error;
  }
  const placeModel = createPlaceModel({
    cooldownMs: runtimeConfig.placeCooldownSeconds * 1_000,
    networkCap: runtimeConfig.placeNetworkCap,
    now,
    saved,
  });
  const placeSaver = startPlaceSaver(placeModel, placeBackend, app.log, placeSaveIntervalMs);
  app.addHook("onClose", () => placeSaver.flush());
  await registerRealtime(app, runtimeConfig, placeModel);
  if (runtimeConfig.placeAdminToken) {
    await registerPlaceAdminRoutes(app, runtimeConfig.placeAdminToken, placeModel);
  }
  if (runtimeConfig.nodeEnv === "development") {
    await registerPlaceDebugRoutes(app, runtimeConfig, placeModel);
  }
  if (runtimeConfig.nodeEnv !== "production") {
    await registerJevRoute(app, runtimeConfig);
  }

  return app;
}
