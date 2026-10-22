import assert from "node:assert/strict";
import test from "node:test";
import { safeRedirectPath } from "../src/utils/router.util";

test("redirects preserve local destinations and reject executable or foreign URLs", () => {
  for (const value of [
    "/upload",
    "/share/example?download=true#file",
    "/account",
  ]) {
    assert.equal(safeRedirectPath(value), value);
  }
  for (const value of [
    undefined,
    null,
    [],
    ["/upload"],
    "javascript:alert(1)",
    "https://evil.invalid",
    "//evil.invalid",
    "/\\evil.invalid",
    "/\nevil.invalid",
    " /upload",
  ]) {
    assert.equal(safeRedirectPath(value), "/", String(value));
  }
});
