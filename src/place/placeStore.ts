import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CANVAS_HEIGHT, CANVAS_WIDTH, HISTORY_CAPACITY, MAX_COLOR, PALETTE, type PlaceModel, type PlaceSave } from "./placeModel.js";

/**
 * Interim disk persistence for Place (durable storage is a later ticket). The
 * Canvas and Placement History share one file so a single rename keeps them
 * consistent. Cooldowns are never saved.
 */

export const SAVE_FILE = "place.json";
export const SAVE_INTERVAL_MS = 30_000;

interface Log {
  info(message: string): void;
  warn(message: string): void;
}

function saveSchema<V extends number>(version: V, pixelBytes: number, maxColor: number) {
  const color = z.number().int().min(0).max(maxColor);
  return z.object({
    version: z.literal(version),
    width: z.literal(CANVAS_WIDTH),
    height: z.literal(CANVAS_HEIGHT),
    pixels: z.string().refine(
      (value) => Buffer.from(value, "base64").byteLength === pixelBytes,
      "pixels must decode to the Canvas size",
    ),
    history: z.array(z.object({
      x: z.number().int().min(0).max(CANVAS_WIDTH - 1),
      y: z.number().int().min(0).max(CANVAS_HEIGHT - 1),
      color,
      previousColor: color,
      visitorHash: z.string(),
      networkHash: z.string(),
      at: z.number(),
    })).max(HISTORY_CAPACITY),
  });
}

/** Version 1 stored 4-bit Palette indices, two Pixels per byte; version 2 stores any RGB color. */
const v1Schema = saveSchema(1, CANVAS_WIDTH * CANVAS_HEIGHT / 2, PALETTE.length - 1);
const v2Schema = saveSchema(2, CANVAS_WIDTH * CANVAS_HEIGHT * 3, MAX_COLOR);
const anySave = z.discriminatedUnion("version", [v1Schema, v2Schema]);

const paletteColor = (index: number) => Number.parseInt(PALETTE[index].slice(1), 16);

/** Turns a version 1 save's Palette indices into RGB colors. */
function upgrade(save: z.infer<typeof anySave>): PlaceSave {
  if (save.version === 2) return save;
  const packed = Buffer.from(save.pixels, "base64");
  const rgb = Buffer.alloc(CANVAS_WIDTH * CANVAS_HEIGHT * 3);
  for (let pixel = 0; pixel < CANVAS_WIDTH * CANVAS_HEIGHT; pixel++) {
    const byte = packed[pixel >> 1];
    const color = paletteColor(pixel & 1 ? byte & 0x0f : byte >> 4);
    rgb.writeUIntBE(color, pixel * 3, 3);
  }
  return {
    ...save,
    version: 2,
    pixels: rgb.toString("base64"),
    history: save.history.map(entry => ({
      ...entry,
      color: paletteColor(entry.color),
      previousColor: paletteColor(entry.previousColor),
    })),
  };
}

/**
 * Reads the saved Place. A missing file means a fresh Canvas. A corrupt one is
 * renamed aside (so the next save cannot overwrite it) and Place starts empty.
 */
export async function loadPlace(dataDir: string, log: Log, now = Date.now): Promise<PlaceSave | undefined> {
  const file = join(dataDir, SAVE_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const saved = upgrade(anySave.parse(JSON.parse(text)));
    log.info(`Loaded the Place Canvas and ${saved.history.length} Placement History entries from ${file}`);
    return saved;
  } catch (error) {
    const aside = `${file}.corrupt-${now()}`;
    await rename(file, aside);
    log.warn(`Place save file is corrupt; starting with an empty Canvas. Kept it at ${aside}: ${(error as Error).message}`);
  }
}

/** Saves the model at most every `intervalMs` when it has changed, and on `flush()` (graceful shutdown). */
export function startPlaceSaver(model: PlaceModel, dataDir: string, log: Log, intervalMs = SAVE_INTERVAL_MS) {
  const file = join(dataDir, SAVE_FILE);
  let savedChangeCount = model.changeCount;
  let saving: Promise<void> = Promise.resolve();

  function save(): Promise<void> {
    saving = saving.then(async () => {
      const changeCount = model.changeCount;
      if (changeCount === savedChangeCount) return;
      await mkdir(dataDir, { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(model.serialize()));
      await rename(temp, file);
      savedChangeCount = changeCount;
    }).catch((error: Error) => log.warn(`Could not save Place to ${file}: ${error.message}`));
    return saving;
  }

  const timer = setInterval(() => void save(), intervalMs);
  timer.unref();

  return {
    async flush(): Promise<void> {
      clearInterval(timer);
      await save();
    },
  };
}
