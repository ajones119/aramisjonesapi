/** The r/place 2017 palette. Index 0 (white) is the empty-Canvas color. */
export const PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
] as const;

export const CANVAS_WIDTH = 128;
export const CANVAS_HEIGHT = 128;

/** Everything a visitor needs to draw the whole Canvas. */
export interface CanvasSnapshot {
  palette: readonly string[];
  width: number;
  height: number;
  /** 4-bit Palette indices, two Pixels per byte (high nibble first), row-major. */
  pixels: Uint8Array;
}

export interface PlaceModel {
  snapshot(): CanvasSnapshot;
}

export function createPlaceModel(): PlaceModel {
  const pixels = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT);

  return {
    snapshot() {
      const packed = new Uint8Array(Math.ceil(pixels.length / 2));
      for (let index = 0; index < pixels.length; index += 2) {
        packed[index / 2] = (pixels[index] << 4) | (pixels[index + 1] ?? 0);
      }
      return { palette: PALETTE, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, pixels: packed };
    },
  };
}
