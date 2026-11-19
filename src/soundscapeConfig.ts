import { z } from "zod";
import type { Config } from "./config.js";

export interface SoundPlaybackConfig {
  mode: "loop";
  noiseMultiplier: number;
  loopDelay: number;
}

export type SoundCategory = "effect" | "music" | "ambiance";

export interface SoundDefinition {
  id: string;
  title: string;
  emoji: string;
  category: SoundCategory;
  tags: string[];
  description: string;
  file: string;
  playback: SoundPlaybackConfig;
}

export const SOUNDSCAPE_ROUTING_TAGS = [
  "magic",
  "calm",
  "sad",
  "hopeful",
  "suspense",
  "horror",
  "heroic",
  "comedy",
  "combat",
  "stealth",
  "investigation",
  "travel",
  "outdoors",
  "night",
  "weather",
  "ritual",
  "mystery",
  "reveal",
  "danger",
  "tense",
] as const;

const soundRowSchema = z.object({
  id: z.union([z.number().int(), z.string().trim().min(1)]).transform(String),
  created_at: z.string().min(1),
  description: z.string().nullable(),
  name: z.string().nullable(),
  emoji: z.string().nullable(),
  url: z.string().nullable(),
  tags: z.array(z.string()),
  type: z.enum(["effect", "music", "ambiance"]),
  noise_multiplier: z.number().finite().nonnegative(),
  loop_delay: z.number().finite().nonnegative(),
});

const soundRowsSchema = z.array(soundRowSchema);
const SOUNDSCAPE_CACHE_TTL_MS = 10 * 60 * 1000;
const soundscapeCache = new Map<string, { sounds: SoundDefinition[]; expiresAt: number }>();
const soundscapeRequests = new Map<string, Promise<SoundDefinition[]>>();

export class SoundscapeCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SoundscapeCatalogError";
  }
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function mapSoundRow(row: z.infer<typeof soundRowSchema>): SoundDefinition {
  const title = row.name?.trim() || `Sound ${row.id}`;

  return {
    id: row.id,
    title,
    emoji: row.emoji?.trim() || "🔊",
    category: row.type,
    tags: normalizeTags(row.tags),
    description: row.description?.trim() || `${title} soundscape layer.`,
    file: row.url?.trim() || "",
    playback: {
      mode: "loop",
      noiseMultiplier: row.noise_multiplier,
      loopDelay: row.loop_delay,
    },
  };
}

async function fetchSoundscapeSounds(
  runtimeConfig: Pick<Config, "supabaseUrl" | "supabasePublishableKey">,
): Promise<SoundDefinition[]> {
  const baseUrl = runtimeConfig.supabaseUrl.endsWith("/")
    ? runtimeConfig.supabaseUrl
    : `${runtimeConfig.supabaseUrl}/`;
  const endpoint = new URL("rest/v1/Soundscape_Sounds", baseUrl);
  endpoint.searchParams.set(
    "select",
    "id,created_at,description,name,emoji,url,tags,type,noise_multiplier,loop_delay",
  );
  endpoint.searchParams.set("order", "id.asc");

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        apikey: runtimeConfig.supabasePublishableKey,
        Authorization: `Bearer ${runtimeConfig.supabasePublishableKey}`,
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new SoundscapeCatalogError("Could not reach the soundscape catalog.", { cause: error });
  }

  if (!response.ok) {
    throw new SoundscapeCatalogError(`Soundscape catalog returned HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new SoundscapeCatalogError("Soundscape catalog returned invalid JSON.", { cause: error });
  }

  const parsed = soundRowsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SoundscapeCatalogError("Soundscape catalog returned invalid rows.", { cause: parsed.error });
  }

  return parsed.data.map(mapSoundRow);
}

export async function loadSoundscapeSounds(
  runtimeConfig: Pick<Config, "supabaseUrl" | "supabasePublishableKey">,
): Promise<SoundDefinition[]> {
  const cacheKey = runtimeConfig.supabaseUrl;
  const now = Date.now();
  const cached = soundscapeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.sounds;

  const pending = soundscapeRequests.get(cacheKey);
  if (pending) return pending;

  const request = fetchSoundscapeSounds(runtimeConfig)
    .then((sounds) => {
      soundscapeCache.set(cacheKey, {
        sounds,
        expiresAt: Date.now() + SOUNDSCAPE_CACHE_TTL_MS,
      });
      return sounds;
    })
    .finally(() => {
      soundscapeRequests.delete(cacheKey);
    });

  soundscapeRequests.set(cacheKey, request);
  return request;
}

export const SOUNDSCAPE_SELECTION_THRESHOLD = 0.6;

export function getSoundscapeTags(): string[] {
  return [...SOUNDSCAPE_ROUTING_TAGS];
}
