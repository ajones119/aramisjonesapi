import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4322),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CORS_ORIGINS: z.string().default("http://localhost:4321,https://aramisjones.com,https://www.aramisjones.com"),
  PLACE_COOKIE_SECRET: z.string().trim().min(1).optional(),
  PLACE_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(600),
  PLACE_NETWORK_CAP: z.coerce.number().int().positive().default(4),
  // Admin routes exist only when this is set. Use a long random value (e.g. openssl rand -hex 32).
  PLACE_ADMIN_TOKEN: z.string().trim().min(16).optional(),
  // Where the Canvas and Placement History are saved. On ephemeral hosts this is lost on redeploy.
  PLACE_DATA_DIR: z.string().trim().min(1).default("data/place"),
  TYPESAFE_API_KEY: z.string().trim().min(1),
  SUPABASE_URL: z.string().trim().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().trim().min(1),
}).refine((env) => env.NODE_ENV !== "production" || env.PLACE_COOKIE_SECRET !== undefined, {
  path: ["PLACE_COOKIE_SECRET"],
  message: "PLACE_COOKIE_SECRET is required in production",
});

const values = environmentSchema.parse(process.env);
const corsOrigins = values.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);

export const config = {
  nodeEnv: values.NODE_ENV,
  port: values.PORT,
  host: values.HOST,
  trustProxy: values.TRUST_PROXY,
  corsOrigins,
  placeCookieSecret: values.PLACE_COOKIE_SECRET ?? "development-only-place-cookie-secret",
  placeCooldownSeconds: values.PLACE_COOLDOWN_SECONDS,
  placeNetworkCap: values.PLACE_NETWORK_CAP,
  placeAdminToken: values.PLACE_ADMIN_TOKEN,
  placeDataDir: values.PLACE_DATA_DIR,
  typesafeApiKey: values.TYPESAFE_API_KEY,
  supabaseUrl: values.SUPABASE_URL,
  supabasePublishableKey: values.SUPABASE_PUBLISHABLE_KEY,
} as const;

export type Config = typeof config;
