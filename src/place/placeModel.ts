/** The r/place 2017 palette. Index 0 (white) is the empty-Canvas color. */
export const PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
] as const;

export const CANVAS_WIDTH = 128;
export const CANVAS_HEIGHT = 128;

export interface CanvasSnapshot {
  palette: readonly string[];
  width: number;
  height: number;
  /** 4-bit Palette indices, two Pixels per byte (high nibble first), row-major. */
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

export interface PlaceModel {
  place(message: unknown, identity: PlaceIdentity): PlacementResult;
  snapshot(visitorHash: string): CanvasSnapshot;
}

interface PlaceModelOptions {
  cooldownMs: number;
  networkCap: number;
  now?: () => number;
}

export function createPlaceModel({
  cooldownMs,
  networkCap,
  now = Date.now,
}: PlaceModelOptions): PlaceModel {
  const pixels = new Uint8Array(Math.ceil(CANVAS_WIDTH * CANVAS_HEIGHT / 2));
  const visitorCooldowns = new Map<string, number>();
  const networkPlacements = new Map<string, number[]>();

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
      if (!isIndex(color, PALETTE.length)) {
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

      const recent = networkPlacements.get(identity.networkHash) ?? [];
      const cutoff = serverNow - cooldownMs;
      let expired = 0;
      while (expired < recent.length && recent[expired] <= cutoff) expired++;
      if (expired) recent.splice(0, expired);
      if (recent.length >= networkCap) {
        return {
          accepted: false,
          reason: "network_cap",
          nextAllowedAt: recent[0] + cooldownMs,
          serverNow,
        };
      }

      const index = y * CANVAS_WIDTH + x;
      const byte = index >> 1;
      pixels[byte] = index & 1
        ? (pixels[byte] & 0xf0) | color
        : (pixels[byte] & 0x0f) | (color << 4);
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
  };
}
