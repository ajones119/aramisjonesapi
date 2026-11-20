import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { z } from "zod";
import type { SaveBackend } from "./placeStore.js";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const rowsSchema = z.array(z.object({ save_gzip: z.string() })).max(1);

/** Only server credentials are accepted here. Never include headers or response bodies in errors. */
export function supabaseBackend(url: string, secretKey: string): SaveBackend {
  const endpoint = new URL("rest/v1/place_save", url.endsWith("/") ? url : `${url}/`);
  const headers = { apikey: secretKey, Authorization: `Bearer ${secretKey}` };

  let loadedRaw: string | undefined;

  async function upsert(id: number, save_gzip: string) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id, save_gzip, saved_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Do not propagate fetch errors: malformed headers can contain secrets.
      throw new Error("Could not reach Place storage.");
    }
    if (!response.ok) throw new Error(`Place storage returned HTTP ${response.status}.`);
    await response.arrayBuffer();
  }

  return {
    async read(signal) {
      const query = new URL(endpoint);
      query.search = "id=eq.1&select=save_gzip";
      const timeout = AbortSignal.timeout(10_000);
      let response: Response;
      try {
        response = await fetch(query, {
          headers,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch {
        // As in upsert: fetch errors are not propagated, so logged messages never carry secrets.
        throw new Error("Could not reach Place storage.");
      }
      if (!response.ok) throw new Error(`Place storage returned HTTP ${response.status}.`);
      const parsed = rowsSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new Error("Place storage returned an unexpected response.");
      const rows = parsed.data;
      if (!rows.length) return;
      loadedRaw = rows[0].save_gzip;
      try {
        return (await decompress(Buffer.from(loadedRaw, "base64"))).toString("utf8");
      } catch {
        // Storage was reached, but its bytes are corrupt. loadPlace validates
        // this invalid JSON marker and setAside preserves the ORIGINAL bytes.
        return "";
      }
    },
    async write(json) {
      await upsert(1, (await compress(json)).toString("base64"));
    },
    async setAside(json) {
      const raw = loadedRaw ?? (await compress(json)).toString("base64");
      await upsert(2, raw);
      return `Supabase place_save row 2 (${raw.length} characters)`;
    },
  };
}
