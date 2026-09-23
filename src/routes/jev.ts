import type { FastifyInstance } from "fastify";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeClient,
  choice,
  noul,
  score,
} from "@typesafe-ai/sdk";
import type { EntryType } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { Config } from "../config.js";

const jsonValueSchema = z.json();
const entrySchema = z.union([
  z.string(),
  z.record(z.string(), jsonValueSchema),
  z.array(jsonValueSchema),
  z.null(),
]);
const stateSchema = z.union([
  z.string(),
  z.record(z.string(), jsonValueSchema),
  z.array(jsonValueSchema),
]);

const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: entrySchema.optional(),
  criteria: z.object({
    true: entrySchema.optional(),
    false: entrySchema.optional(),
  }).strict().optional(),
}).strict();

const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: entrySchema.optional(),
  criteria: z.record(z.string(), entrySchema).refine((criteria) => !Array.isArray(criteria)),
}).strict();

const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: entrySchema.optional(),
  criteria: z.array(entrySchema).min(2),
}).strict();

const questionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

const jevRequestSchema = z.object({
  state: stateSchema,
  model: z.string().trim().min(1).default("jev-latest"),
  questions: z.record(z.string().min(1), questionSchema).refine((questions) => Object.keys(questions).length > 0),
}).strict();

function safeErrorBody(body: unknown): unknown {
  if (body === null || typeof body === "string" || typeof body === "number" || typeof body === "boolean") {
    return body;
  }
  if (Array.isArray(body)) return body;
  if (typeof body === "object") return body;
  return { error: "upstream request failed" };
}

export async function registerJevRoute(app: FastifyInstance, config: Config): Promise<void> {
  const client = new TypeSafeClient({ apiKey: config.typesafeApiKey });

  app.post(
    "/api/jev",
    {
      schema: {
        tags: ["jev"],
        summary: "Evaluate typed questions with TypeSafe Jev",
        body: jevRequestSchema,
      },
    },
    async (request, reply) => {
      const { state, model, questions: inputQuestions } = request.body as z.infer<typeof jevRequestSchema>;
      const questions = Object.fromEntries(
        Object.entries(inputQuestions).map(([name, question]) => {
          if (question.type === "noul") return [name, noul(question.instructions ?? null, question.criteria)];
          if (question.type === "choice") return [name, choice(question.instructions ?? null, question.criteria)];
          return [name, score(question.instructions ?? null, question.criteria as [EntryType, EntryType, ...EntryType[]])];
        }),
      );

      try {
        const result = await client.systemOne({ state, model, questions });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof APIError) {
          return reply.code(error.status).send(safeErrorBody(error.body));
        }
        if (error instanceof APITimeoutError) {
          return reply.code(504).send({ error: "upstream request timed out" });
        }
        if (error instanceof APIConnectionError) {
          return reply.code(502).send({ error: "upstream request failed" });
        }
        request.log.error({ err: error }, "Unexpected Jev request failure");
        return reply.code(500).send({ error: "internal server error" });
      }
    },
  );
}
