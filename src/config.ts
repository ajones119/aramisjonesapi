import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4322),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CORS_ORIGINS: z.string().default("http://localhost:4321,https://aramisjones.com,https://www.aramisjones.com"),
  TYPESAFE_API_KEY: z.string().trim().min(1),
  SUPABASE_URL: z.string().trim().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().trim().min(1),
});

const values = environmentSchema.parse(process.env);
const corsOrigins = values.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);

export const config = {
  nodeEnv: values.NODE_ENV,
  port: values.PORT,
  host: values.HOST,
  trustProxy: values.TRUST_PROXY,
  corsOrigins,
  typesafeApiKey: values.TYPESAFE_API_KEY,
  supabaseUrl: values.SUPABASE_URL,
  supabasePublishableKey: values.SUPABASE_PUBLISHABLE_KEY,
} as const;

export type Config = typeof config;
