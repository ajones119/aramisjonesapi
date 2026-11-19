import { Room, type Client } from "@colyseus/core";
import type { PlaceModel } from "./placeModel.js";

export const PLACE_ROOM = "place";

/**
 * Builds the room class for the single, never-disposed Place room. The model is
 * closed over rather than passed as room options, so it is never serialized.
 */
export function createPlaceRoom(model: PlaceModel) {
  return class PlaceRoom extends Room {
    autoDispose = false;

    onJoin(client: Client) {
      // One message so the page never sees Pixels without the Palette and size that decode them.
      client.send("canvas", model.snapshot());
    }
  };
}
