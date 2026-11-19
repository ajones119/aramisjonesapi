import { Room, ServerError, type AuthContext, type Client } from "@colyseus/core";
import type { PlaceIdentity, PlaceModel } from "./placeModel.js";
import { authenticateVisitor, hashNetwork } from "./visitorCookie.js";

export const PLACE_ROOM = "place";

/**
 * Builds the room class for the single, never-disposed Place room. The model is
 * closed over rather than passed as room options, so it is never serialized.
 */
export function createPlaceRoom(model: PlaceModel, cookieSecret: string) {
  return class PlaceRoom extends Room {
    static override async onAuth(_token: string, _options: unknown, context: AuthContext) {
      const visitorHash = authenticateVisitor(context.headers.get("cookie"), cookieSecret);
      if (!visitorHash) throw new ServerError(401, "invalid_visitor");
      if (!context.ip) throw new ServerError(401, "invalid_network");
      return { visitorHash, networkHash: hashNetwork(context.ip, cookieSecret) } satisfies PlaceIdentity;
    }

    autoDispose = false;

    onCreate() {
      this.onMessage("place", (client, message: unknown) => {
        const result = model.place(message, client.auth as PlaceIdentity);
        if (!result.accepted) {
          client.send("place:rejected", {
            reason: result.reason,
            nextAllowedAt: result.nextAllowedAt,
            serverNow: result.serverNow,
          });
          return;
        }
        client.send("place:accepted", {
          nextAllowedAt: result.nextAllowedAt,
          serverNow: result.serverNow,
        });
        this.broadcast("placed", result.placement);
      });
    }

    onJoin(client: Client) {
      // One message so the page never sees Pixels without the Palette, size, and Cooldown status.
      const { visitorHash } = client.auth as PlaceIdentity;
      client.send("canvas", model.snapshot(visitorHash));
    }
  };
}
