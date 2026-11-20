import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  CANVAS_HEIGHT, CANVAS_WIDTH, EMPTY, HISTORY_CAPACITY, LEGACY_PALETTE, MAX_COLOR, WHITE,
  type HistoryEntry, type PlaceModel, type PlaceSave,
} from "./placeModel.js";

/**
 * Snapshot persistence for the Canvas and Placement History. Cooldowns are never saved.
 */

export const SAVE_FILE = "place.json";
export const SAVE_INTERVAL_MS = 30_000;

interface Log {
  info(message: string): void;
  warn(message: string): void;
}

function saveSchema<V extends number>(version: V, size: number, bytesPerPixel: number, minColor: number, maxColor: number) {
  const color = z.number().int().min(minColor).max(maxColor);
  const pixelBytes = size * size * bytesPerPixel;
  return z.object({
    version: z.literal(version),
    width: z.literal(size),
    height: z.literal(size),
    pixels: z.string().refine(
      (value) => Buffer.from(value, "base64").byteLength === pixelBytes,
      "pixels must decode to the Canvas size",
    ),
    history: z.array(z.object({
      x: z.number().int().min(0).max(size - 1),
      y: z.number().int().min(0).max(size - 1),
      color,
      previousColor: color,
      visitorHash: z.string(),
      networkHash: z.string(),
      at: z.number(),
    })).max(HISTORY_CAPACITY),
  });
}

/**
 * Save file versions:
 * 1. 128×128, 4-bit indices into the r/place 2017 colors, two Pixels per byte.
 * 2. 128×128, RGB (three bytes per Pixel); white doubled as "unpainted".
 * 3. 256×256, RGBA (four bytes per Pixel); alpha 0 is an empty Pixel.
 */
const OLD_SIZE = 128;
const v1Schema = saveSchema(1, OLD_SIZE, 0.5, 0, LEGACY_PALETTE.length - 1);
const v2Schema = saveSchema(2, OLD_SIZE, 3, 0, MAX_COLOR);
const v3Schema = saveSchema(3, CANVAS_WIDTH, 4, EMPTY, MAX_COLOR);
const anySave = z.discriminatedUnion("version", [v1Schema, v2Schema, v3Schema]);

const paletteColor = (index: number) => Number.parseInt(LEGACY_PALETTE[index].slice(1), 16);

/**
 * Brings an older save up to version 3: one color per Pixel, white as empty
 * (it was the old background, indistinguishable from unpainted), placed in the
 * center of the larger Canvas with Placement History moved to match.
 */
function upgrade(save: z.infer<typeof anySave>): PlaceSave {
  if (save.version === 3) return save;
  const old = Buffer.from(save.pixels, "base64");
  const oldColorAt = save.version === 1
    ? (pixel: number) => paletteColor(pixel & 1 ? old[pixel >> 1] & 0x0f : old[pixel >> 1] >> 4)
    : (pixel: number) => old.readUIntBE(pixel * 3, 3);
  const asEmpty = (color: number) => (color === WHITE ? EMPTY : color);
  const toColor = save.version === 1 ? (index: number) => asEmpty(paletteColor(index)) : asEmpty;

  const offset = (CANVAS_WIDTH - OLD_SIZE) / 2;
  const rgba = Buffer.alloc(CANVAS_WIDTH * CANVAS_HEIGHT * 4);
  for (let y = 0; y < OLD_SIZE; y++) {
    for (let x = 0; x < OLD_SIZE; x++) {
      const color = asEmpty(oldColorAt(y * OLD_SIZE + x));
      if (color === EMPTY) continue;
      const i = ((y + offset) * CANVAS_WIDTH + x + offset) * 4;
      rgba.writeUIntBE(color, i, 3);
      rgba[i + 3] = 0xff;
    }
  }
  return {
    version: 3,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    pixels: rgba.toString("base64"),
    history: save.history.map((entry): HistoryEntry => ({
      ...entry,
      x: entry.x + offset,
      y: entry.y + offset,
      color: toColor(entry.color),
      previousColor: toColor(entry.previousColor),
    })),
  };
}

export interface SaveBackend {
  /** JSON text, or undefined for a new Place. Unreachable storage must throw. */
  read(signal?: AbortSignal): Promise<string | undefined>;
  write(json: string): Promise<void>;
  /** Keeps a corrupt save out of the way; returns where it went, for the log. */
  setAside(json: string): Promise<string>;
}

/** Backend errors are written to be safe to log (no keys, headers or bodies). */
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function diskBackend(dataDir: string, now = Date.now): SaveBackend {
  const file = join(dataDir, SAVE_FILE);
  return {
    async read() {
      try {
        return await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    },
    async write(json) {
      await mkdir(dataDir, { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, json);
      await rename(temp, file);
    },
    async setAside() {
      const aside = `${file}.corrupt-${now()}`;
      await rename(file, aside);
      return aside;
    },
  };
}

/** A read failure is fatal; only missing or successfully preserved corrupt saves start empty. */
export async function loadPlace(backend: SaveBackend, log: Log, retryMs = 0): Promise<PlaceSave | undefined> {
  const deadline = Date.now() + retryMs;
  const signal = AbortSignal.timeout(Math.max(1, retryMs));
  let backoff = Math.min(1_000, retryMs / 4);
  let warned = false;
  let text: string | undefined;
  for (;;) {
    try {
      text = await backend.read(retryMs > 0 ? signal : undefined);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`Could not load Place; refusing to start with an empty Canvas. ${reason(error)}`);
      if (!warned) {
        log.warn(`Could not read Place; retrying before startup. ${reason(error)}`);
        warned = true;
      }
      await delay(Math.min(backoff, deadline - Date.now()));
      if (Date.now() >= deadline) throw new Error("Could not load Place; refusing to start with an empty Canvas.");
      backoff = Math.min(backoff * 2, 10_000);
    }
  }
  if (text === undefined) return;
  let saved: PlaceSave;
  try {
    saved = upgrade(anySave.parse(JSON.parse(text)));
  } catch (error) {
    const aside = await backend.setAside(text);
    log.warn(`Place save is corrupt; kept it at ${aside} and starting with an empty Canvas. ${reason(error)}`);
    return;
  }
  log.info(`Loaded the Place Canvas and ${saved.history.length} Placement History entries`);
  return saved;
}

/** Saves at most every interval when changed, and flushes on graceful shutdown. */
export function startPlaceSaver(model: PlaceModel, backend: SaveBackend, log: Log, intervalMs = SAVE_INTERVAL_MS) {
  let savedChangeCount = model.changeCount;
  let saving: Promise<void> = Promise.resolve();
  let pending = false;
  let failing = false;

  function save(): Promise<void> {
    pending = true;
    saving = saving.then(async () => {
      const changeCount = model.changeCount;
      if (changeCount === savedChangeCount) return;
      await backend.write(JSON.stringify(model.serialize()));
      savedChangeCount = changeCount;
      failing = false;
    }).catch((error: unknown) => {
      if (!failing) log.warn(`Could not save Place; will retry on the next tick. ${reason(error)}`);
      failing = true;
    }).finally(() => { pending = false; });
    return saving;
  }

  const timer = setInterval(() => { if (!pending) void save(); }, intervalMs);
  timer.unref();

  return {
    async flush(): Promise<void> {
      clearInterval(timer);
      let cap: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          save(),
          new Promise<void>(resolve => {
            cap = setTimeout(() => {
              log.warn("Place shutdown save exceeded 20 seconds; stopping the flush.");
              resolve();
            }, 20_000);
          }),
        ]);
      } finally {
        clearTimeout(cap);
      }
    },
  };
}
