import type { FastifyInstance } from "fastify";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeClient,
  noul,
  score,
} from "@typesafe-ai/sdk";
import type { EntryType, ScoreResponse } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import { FixedWindowRateLimiter } from "../rateLimiter.js";
import {
  SoundscapeCatalogError,
  SOUNDSCAPE_SELECTION_THRESHOLD,
  getSoundscapeTags,
  loadSoundscapeSounds,
  type SoundDefinition,
} from "../soundscapeConfig.js";
import { TimedCache } from "../timedCache.js";

const sceneDescriptionSchema = z.string().trim().min(1).max(1000);
const limitsSchema = z.record(z.string().trim().min(1), z.number().int().min(0).max(20));
const resolveSchema = z.object({
  sceneDescription: sceneDescriptionSchema,
  limits: limitsSchema,
}).strict();

type ResolveInput = z.infer<typeof resolveSchema>;

interface MatchResult {
  id: string;
  category?: string;
  probability: number;
  selected: boolean;
}

interface TagMatch {
  tag: string;
  probability: number;
  selected: boolean;
}

interface SoundMatch extends MatchResult {
  id: string;
  category: string;
}

interface VolumeMatch {
  id: string;
  score: number;
  level: number;
  label: VolumeLabel;
}

interface SoundscapeResolveResponse {
  selectedSoundIds: string[];
  tagMatches: TagMatch[];
  soundMatches: SoundMatch[];
  unknownCategories: string[];
  soundLevels: Record<string, number>;
  volumeMatches: VolumeMatch[];
}

type VolumeLabel = "silent" | "subtle" | "present" | "strong" | "foreground";

const VOLUME_RUBRIC = [
  "silent: mute or effectively inaudible in the scene",
  "subtle: quiet background presence, clearly below the other layers",
  "present: audible and balanced with the other layers",
  "strong: prominent and attention-holding, but not the main foreground layer",
  "foreground: the nearest or most important layer, clearly dominant",
] as const;

const SOUNDSCAPE_RATE_LIMIT = 30;
const SOUNDSCAPE_RATE_WINDOW_MS = 10 * 60 * 1000;
const SOUNDSCAPE_RESOLUTION_TTL_MS = 10 * 60 * 1000;
const SOUNDSCAPE_RESOLUTION_CACHE_MAX_ENTRIES = 500;

export function resolutionCacheKey(sceneDescription: string, limits: Record<string, number>): string {
  const normalizedScene = sceneDescription.trim().replace(/\s+/g, " ").toLowerCase();
  const normalizedLimits = Object.fromEntries(
    Object.entries(limits).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({ scene: normalizedScene, limits: normalizedLimits });
}

function setRateLimitHeaders(reply: { header(name: string, value: string | number): unknown }, decision: {
  limit: number;
  remaining: number;
  resetAt: number;
}): void {
  reply.header("X-RateLimit-Limit", decision.limit);
  reply.header("X-RateLimit-Remaining", decision.remaining);
  reply.header("X-RateLimit-Reset", Math.ceil(decision.resetAt / 1000));
}

function volumeLevel(scoreValue: number): { score: number; level: number; label: VolumeLabel } {
  const score = Math.min(4, Math.max(0, scoreValue));
  const level = Math.min(1, Math.max(0, score / 4));
  const label = VOLUME_RUBRIC[Math.min(4, Math.max(0, Math.floor(score + 0.5)))].split(":")[0] as VolumeLabel;
  return { score, level, label };
}

function safeErrorBody(body: unknown): unknown {
  if (body === null || typeof body === "string" || typeof body === "number" || typeof body === "boolean") return body;
  if (Array.isArray(body) || typeof body === "object") return body;
  return { error: "upstream request failed" };
}

function answerProbability(answer: { noul: number } | undefined): number {
  return answer?.noul ?? 0;
}

function questionKey(prefix: string, value: string): string {
  return `${prefix}_${value.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function candidateSounds(sounds: readonly SoundDefinition[], selectedTags: ReadonlySet<string>): SoundDefinition[] {
  return sounds.filter((sound) => sound.tags.some((tag) => selectedTags.has(tag)));
}

function selectByCategory(
  sounds: readonly SoundDefinition[],
  soundMatches: readonly MatchResult[],
  limits: Record<string, number>,
): string[] {
  const selectedIds: string[] = [];
  const byCategory = new Map<string, MatchResult[]>();

  for (const match of soundMatches) {
    if (!match.category || !match.selected) continue;
    const matches = byCategory.get(match.category) ?? [];
    matches.push(match);
    byCategory.set(match.category, matches);
  }

  for (const [category, matches] of byCategory) {
    const limit = limits[category] ?? 0;
    if (limit <= 0) continue;
    matches.sort((left, right) => right.probability - left.probability);
    selectedIds.push(...matches.slice(0, limit).map((match) => match.id));
  }

  return sounds.filter((sound) => selectedIds.includes(sound.id)).map((sound) => sound.id);
}

export async function registerSoundscapeRoute(app: FastifyInstance, config: Config): Promise<void> {
  const client = new TypeSafeClient({ apiKey: config.typesafeApiKey });
  const rateLimiter = new FixedWindowRateLimiter({
    limit: SOUNDSCAPE_RATE_LIMIT,
    windowMs: SOUNDSCAPE_RATE_WINDOW_MS,
  });
  const resolutionCache = new TimedCache<SoundscapeResolveResponse>({
    ttlMs: SOUNDSCAPE_RESOLUTION_TTL_MS,
    maxEntries: SOUNDSCAPE_RESOLUTION_CACHE_MAX_ENTRIES,
  });

  app.get("/api/soundscape/config", {
    schema: {
      tags: ["soundscape"],
      summary: "Get the server-owned soundscape catalog",
    },
  }, async (request, reply) => {
    try {
      const sounds = await loadSoundscapeSounds(config);
      return { sounds, tags: getSoundscapeTags() };
    } catch (error) {
      request.log.error({ err: error }, "Soundscape catalog unavailable");
      return reply.code(503).send({ error: "soundscape catalog unavailable" });
    }
  });

  app.post("/api/soundscape/resolve", {
    schema: {
      tags: ["soundscape"],
      summary: "Resolve a scene into a bounded sound selection",
      body: resolveSchema,
    },
    preHandler: async (request, reply) => {
      const decision = rateLimiter.consume(request.ip);
      setRateLimitHeaders(reply, decision);
      if (decision.allowed) return;

      const retryAfterSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
      reply.header("Retry-After", retryAfterSeconds);
      return reply.code(429).send({ error: "rate limit exceeded", retryAfterSeconds });
    },
  }, async (request, reply) => {
    const startedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - startedAt);
    const logStep = (step: string, details: Record<string, unknown> = {}) => {
      request.log.info({ step, elapsedMs: elapsedMs(), ...details }, "Soundscape resolve progress");
    };
    const { sceneDescription, limits } = request.body as ResolveInput;

    logStep("request received", {
      sceneLength: sceneDescription.length,
      limitCategories: Object.keys(limits),
    });

    try {
      const cachedResponse = resolutionCache.get(resolutionCacheKey(sceneDescription, limits));
      if (cachedResponse) {
        logStep("resolution cache hit", { selectedSoundCount: cachedResponse.selectedSoundIds.length });
        return reply.code(200).send(cachedResponse);
      }

      const catalogStartedAt = performance.now();
      const sounds = await loadSoundscapeSounds(config);
      logStep("catalog loaded", {
        durationMs: Math.round(performance.now() - catalogStartedAt),
        soundCount: sounds.length,
      });

      const tags = getSoundscapeTags();
      const tagQuestions = Object.fromEntries(tags.map((tag) => [
        questionKey("tag", tag),
        noul({
          sceneDescription,
          question: `Is the soundscape tag '${tag}' relevant to this scene?`,
        }),
      ]));
      logStep("tag questions prepared", { questionCount: tags.length });

      const tagEvaluationStartedAt = performance.now();
      const tagResult = await client.systemOne({
        state: { sceneDescription, tags },
        questions: tagQuestions,
      });
      logStep("tag evaluation finished", {
        durationMs: Math.round(performance.now() - tagEvaluationStartedAt),
        questionCount: tags.length,
      });

      const tagMatches = tags.map((tag) => {
        const probability = answerProbability(tagResult.answers[questionKey("tag", tag)] as { noul: number } | undefined);
        return { tag, probability, selected: probability >= SOUNDSCAPE_SELECTION_THRESHOLD };
      });
      const selectedTags = new Set(tagMatches.filter((match) => match.selected).map((match) => match.tag));
      const candidates = candidateSounds(sounds, selectedTags);
      logStep("candidate sounds filtered", {
        selectedTagCount: selectedTags.size,
        candidateCount: candidates.length,
      });

      if (!candidates.length) {
        const response: SoundscapeResolveResponse = {
          selectedSoundIds: [],
          tagMatches,
          soundMatches: [],
          unknownCategories: Object.keys(limits).filter((category) => !sounds.some((sound) => sound.category === category)),
          soundLevels: {},
          volumeMatches: [],
        };
        resolutionCache.set(resolutionCacheKey(sceneDescription, limits), response);
        logStep("no candidate sounds; returning", { totalDurationMs: elapsedMs() });
        return reply.code(200).send(response);
      }

      const soundQuestions = Object.fromEntries(candidates.map((sound) => [
        questionKey("sound", sound.id),
        noul({
          sceneDescription,
          sound: sound.description,
          question: `Should the sound '${sound.title}' be active in this scene?`,
        }),
      ]));
      logStep("sound questions prepared", { questionCount: candidates.length });

      const soundEvaluationStartedAt = performance.now();
      const soundResult = await client.systemOne({
        state: { sceneDescription, sounds: candidates as unknown as EntryType },
        questions: soundQuestions,
      });
      logStep("sound evaluation finished", {
        durationMs: Math.round(performance.now() - soundEvaluationStartedAt),
        questionCount: candidates.length,
      });

      const soundMatches = candidates.map((sound) => {
        const probability = answerProbability(soundResult.answers[questionKey("sound", sound.id)] as { noul: number } | undefined);
        return {
          id: sound.id,
          category: sound.category,
          probability,
          selected: probability >= SOUNDSCAPE_SELECTION_THRESHOLD,
        };
      });
      const selectedSoundIds = selectByCategory(sounds, soundMatches, limits);
      const selectedSounds = sounds.filter((sound) => selectedSoundIds.includes(sound.id));
      logStep("sound selection completed", {
        selectedSoundCount: selectedSoundIds.length,
        selectedSoundIds,
      });

      const volumeQuestions = Object.fromEntries(selectedSounds.map((sound) => [
        questionKey("volume", sound.id),
        score({
          sceneDescription,
          sound: {
            id: sound.id,
            title: sound.title,
            category: sound.category,
            description: sound.description,
          },
          question: "How loud should this sound be relative to the other selected layers? Consider indoor/outdoor occlusion, physical distance, weather, and whether it belongs in the foreground or background.",
        }, VOLUME_RUBRIC),
      ]));
      logStep("volume questions prepared", { questionCount: selectedSounds.length });

      const volumeEvaluationStartedAt = performance.now();
      const volumeResult = selectedSounds.length
        ? await client.systemOne({
          state: {
            sceneDescription,
            selectedSounds: selectedSounds.map((sound) => ({
              id: sound.id,
              title: sound.title,
              category: sound.category,
              description: sound.description,
            })),
          } as unknown as EntryType,
          questions: volumeQuestions,
        })
        : null;
      if (selectedSounds.length) {
        logStep("volume evaluation finished", {
          durationMs: Math.round(performance.now() - volumeEvaluationStartedAt),
          questionCount: selectedSounds.length,
        });
      } else {
        logStep("volume evaluation skipped", { reason: "no selected sounds" });
      }

      const volumeMatches = selectedSounds.map((sound) => {
        const answer = volumeResult?.answers[questionKey("volume", sound.id)] as ScoreResponse | undefined;
        if (!answer || !Number.isFinite(answer.score)) throw new Error(`Missing volume score for ${sound.id}`);
        const volume = volumeLevel(answer.score);
        return { id: sound.id, ...volume };
      });
      const soundLevels = Object.fromEntries(volumeMatches.map((match) => [match.id, match.level]));

      logStep("response ready", {
        selectedSoundCount: selectedSoundIds.length,
        totalDurationMs: elapsedMs(),
      });
      const response: SoundscapeResolveResponse = {
        selectedSoundIds,
        tagMatches,
        soundMatches,
        unknownCategories: Object.keys(limits).filter((category) => !sounds.some((sound) => sound.category === category)),
        soundLevels,
        volumeMatches,
      };
      resolutionCache.set(resolutionCacheKey(sceneDescription, limits), response);
      return reply.code(200).send(response);
    } catch (error) {
      logStep("request failed", { totalDurationMs: elapsedMs() });
      if (error instanceof SoundscapeCatalogError) {
        request.log.error({ err: error }, "Soundscape catalog unavailable");
        return reply.code(503).send({ error: "soundscape catalog unavailable" });
      }
      if (error instanceof APIError) return reply.code(error.status).send(safeErrorBody(error.body));
      if (error instanceof APITimeoutError) return reply.code(504).send({ error: "upstream request timed out" });
      if (error instanceof APIConnectionError) return reply.code(502).send({ error: "upstream request failed" });
      request.log.error({ err: error }, "Unexpected soundscape resolution failure");
      return reply.code(500).send({ error: "internal server error" });
    }
  });
}
