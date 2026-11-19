import assert from "node:assert/strict";
import test from "node:test";
import { resolutionCacheKey } from "./soundscape.js";

test("resolution cache keys normalize scene text and canonicalize limits", () => {
  const first = resolutionCacheKey("  A   quiet tavern  ", { music: 1, ambiance: 4 });
  const equivalent = resolutionCacheKey("a quiet tavern", { ambiance: 4, music: 1 });
  const differentLimits = resolutionCacheKey("a quiet tavern", { ambiance: 3, music: 1 });

  assert.equal(first, equivalent);
  assert.notEqual(first, differentLimits);
});
