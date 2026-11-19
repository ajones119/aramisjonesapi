/**
 * The r/place 2017 Palette: the preset colors offered first. Visitors may also
 * place any other 24-bit color with the custom color picker.
 */
export const PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
] as const;

export const CANVAS_WIDTH = 128;
export const CANVAS_HEIGHT = 128;

/** Colors are 24-bit RGB numbers (0xRRGGBB). An empty Canvas is white. */
export const WHITE = 0xFFFFFF;
export const MAX_COLOR = 0xFFFFFF;

export interface CanvasSnapshot {
  palette: readonly string[];
  width: number;
  height: number;
  /** Three bytes (R, G, B) per Pixel, row-major. */
  pixels: Uint8Array;
  nextAllowedAt: number;
  serverNow: number;
}

export interface PlaceIdentity {
  visitorHash: string;
  networkHash: string;
}

export interface Placement {
  x: number;
  y: number;
  color: number;
}

export type PlacementResult =
  | { accepted: true; placement: Placement; nextAllowedAt: number; serverNow: number }
  | {
    accepted: false;
    reason: "out_of_bounds" | "bad_color" | "cooldown" | "network_cap";
    nextAllowedAt?: number;
    serverNow: number;
  };

function isIndex(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < limit;
}

/** What the server knows about one visitor's Cooldown and network, for the dev debug panel. */
export interface CooldownStatus {
  cooldownSeconds: number;
  nextAllowedAt: number;
  serverNow: number;
  networkPlacements: number;
  networkCap: number;
}

export const HISTORY_CAPACITY = 5_000;

/** The pseudo-visitor that admin restorations are recorded under. */
export const ADMIN_VISITOR = "admin";

/** One entry in the Placement History. */
export interface HistoryEntry {
  x: number;
  y: number;
  color: number;
  /** The color this Placement replaced, which a revert restores. */
  previousColor: number;
  visitorHash: string;
  networkHash: string;
  at: number;
}

/** What survives a restart: the Canvas and Placement History, never Cooldowns. */
export interface PlaceSave {
  version: 2;
  width: number;
  height: number;
  /** The Canvas as RGB bytes, base64. */
  pixels: string;
  history: HistoryEntry[];
}

export interface PlaceModel {
  place(message: unknown, identity: PlaceIdentity): PlacementResult;
  snapshot(visitorHash: string): CanvasSnapshot;
  cooldownStatus(identity: PlaceIdentity): CooldownStatus;
  /** Changes the Cooldown length for Placements made from now on; running Cooldowns keep their end time. */
  setCooldownSeconds(seconds: number): void;
  /** Ends the visitor's Cooldown and clears their network's Placement window. */
  resetCooldown(identity: PlaceIdentity): void;
  /** Placement History, newest first. */
  listPlacements(options: { limit: number; visitorHash?: string }): HistoryEntry[];
  /**
   * Undo a visitor's Placements made between `from` and `to` (inclusive). A Pixel
   * is restored only where that visitor's Placement is still the latest one, to
   * the color it had before their run of Placements on it. Returns the restored Pixels.
   */
  revert(visitorHash: string, from: number, to: number): Placement[];
  /** Calls `listener` for every Pixel change, from visitors and from reverts. Returns an unsubscribe function. */
  onPixelChange(listener: (placement: Placement) => void): () => void;
  /** Counts Pixel changes, so a saver can tell whether anything is unsaved. */
  readonly changeCount: number;
  serialize(): PlaceSave;
}

interface PlaceModelOptions {
  cooldownMs: number;
  networkCap: number;
  now?: () => number;
  /** A previously saved Canvas and Placement History to start from. */
  saved?: PlaceSave;
}

export function createPlaceModel({
  cooldownMs: initialCooldownMs,
  networkCap,
  now = Date.now,
  saved,
}: PlaceModelOptions): PlaceModel {
  const pixels = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT * 3).fill(0xff);
  if (saved) pixels.set(Buffer.from(saved.pixels, "base64"));
  const visitorCooldowns = new Map<string, number>();
  const networkPlacements = new Map<string, number[]>();
  let cooldownMs = initialCooldownMs;
  const history: HistoryEntry[] = saved ? saved.history.slice(-HISTORY_CAPACITY) : [];
  let changeCount = 0;
  const listeners = new Set<(placement: Placement) => void>();

  function colorAt(x: number, y: number): number {
    const i = (y * CANVAS_WIDTH + x) * 3;
    return (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
  }

  /** Paints a Pixel, records it in the Placement History, and tells listeners. */
  function paint(placement: Placement, visitorHash: string, networkHash: string, at: number): void {
    const { x, y, color } = placement;
    const previousColor = colorAt(x, y);
    const i = (y * CANVAS_WIDTH + x) * 3;
    pixels[i] = color >> 16;
    pixels[i + 1] = (color >> 8) & 0xff;
    pixels[i + 2] = color & 0xff;
    history.push({ x, y, color, previousColor, visitorHash, networkHash, at });
    if (history.length > HISTORY_CAPACITY) history.shift();
    changeCount++;
    for (const listener of listeners) listener({ x, y, color });
  }

  /** This network's Placement times inside the current Cooldown window, oldest first. */
  function recentPlacements(networkHash: string, serverNow: number): number[] {
    const recent = networkPlacements.get(networkHash) ?? [];
    const cutoff = serverNow - cooldownMs;
    let expired = 0;
    while (expired < recent.length && recent[expired] <= cutoff) expired++;
    if (expired) recent.splice(0, expired);
    return recent;
  }

  return {
    place(message, identity) {
      const serverNow = now();
      if (!message || typeof message !== "object") {
        return { accepted: false, reason: "out_of_bounds", serverNow };
      }
      const { x, y, color } = message as Partial<Record<keyof Placement, unknown>>;
      if (!isIndex(x, CANVAS_WIDTH) || !isIndex(y, CANVAS_HEIGHT)) {
        return { accepted: false, reason: "out_of_bounds", serverNow };
      }
      if (!isIndex(color, MAX_COLOR + 1)) {
        return { accepted: false, reason: "bad_color", serverNow };
      }

      const currentNextAllowedAt = visitorCooldowns.get(identity.visitorHash) ?? serverNow;
      if (currentNextAllowedAt > serverNow) {
        return {
          accepted: false,
          reason: "cooldown",
          nextAllowedAt: currentNextAllowedAt,
          serverNow,
        };
      }

      const recent = recentPlacements(identity.networkHash, serverNow);
      if (recent.length >= networkCap) {
        return {
          accepted: false,
          reason: "network_cap",
          nextAllowedAt: recent[0] + cooldownMs,
          serverNow,
        };
      }

      paint({ x, y, color }, identity.visitorHash, identity.networkHash, serverNow);
      const nextAllowedAt = serverNow + cooldownMs;
      visitorCooldowns.set(identity.visitorHash, nextAllowedAt);
      recent.push(serverNow);
      networkPlacements.set(identity.networkHash, recent);
      return { accepted: true, placement: { x, y, color }, nextAllowedAt, serverNow };
    },
    snapshot(visitorHash) {
      const serverNow = now();
      return {
        palette: PALETTE,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        pixels,
        nextAllowedAt: visitorCooldowns.get(visitorHash) ?? serverNow,
        serverNow,
      };
    },
    cooldownStatus({ visitorHash, networkHash }) {
      const serverNow = now();
      return {
        cooldownSeconds: cooldownMs / 1_000,
        nextAllowedAt: Math.max(visitorCooldowns.get(visitorHash) ?? serverNow, serverNow),
        serverNow,
        networkPlacements: recentPlacements(networkHash, serverNow).length,
        networkCap,
      };
    },
    setCooldownSeconds(seconds) {
      cooldownMs = seconds * 1_000;
    },
    resetCooldown({ visitorHash, networkHash }) {
      visitorCooldowns.delete(visitorHash);
      networkPlacements.delete(networkHash);
    },
    listPlacements({ limit, visitorHash }) {
      const result: HistoryEntry[] = [];
      for (let i = history.length - 1; i >= 0 && result.length < limit; i--) {
        if (visitorHash === undefined || history[i].visitorHash === visitorHash) result.push({ ...history[i] });
      }
      return result;
    },
    revert(visitorHash, from, to) {
      // Walk newest to oldest. A Pixel's first entry is its latest Placement; if
      // it is the visitor's (in range), follow their unbroken run back to find
      // the color from before it.
      const restoreTo = new Map<number, number>();
      const settled = new Set<number>();
      for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        const index = entry.y * CANVAS_WIDTH + entry.x;
        if (settled.has(index)) continue;
        const theirs = entry.visitorHash === visitorHash && entry.at >= from && entry.at <= to;
        if (theirs) {
          restoreTo.set(index, entry.previousColor);
        } else {
          settled.add(index);
        }
      }
      const at = now();
      const restored: Placement[] = [];
      for (const [index, color] of restoreTo) {
        const placement = { x: index % CANVAS_WIDTH, y: Math.floor(index / CANVAS_WIDTH), color };
        paint(placement, ADMIN_VISITOR, ADMIN_VISITOR, at);
        restored.push(placement);
      }
      return restored;
    },
    get changeCount() {
      return changeCount;
    },
    serialize() {
      return {
        version: 2,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        pixels: Buffer.from(pixels).toString("base64"),
        history: history.map(entry => ({ ...entry })),
      };
    },
    onPixelChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
