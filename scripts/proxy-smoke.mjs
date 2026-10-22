import assert from "node:assert/strict";

// Run from an explicitly trusted proxy source against a fresh test container.
const base = process.env.SMOKE_URL || "http://127.0.0.1:18081";
async function signIn(client) {
  const response = await fetch(`${base}/api/auth/signIn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": client,
    },
    body: JSON.stringify({
      email: "proxy-smoke@example.invalid",
      password: "incorrect-disposable-password",
    }),
  });
  await response.arrayBuffer();
  return response.status;
}

for (let attempt = 0; attempt < 20; attempt++) {
  assert.equal(await signIn("198.51.100.10"), 401);
}
assert.equal(await signIn("198.51.100.10"), 429);
assert.equal(await signIn("198.51.100.20"), 401);
console.log("PASS: explicit proxy allowlists preserve separate client rate limits through bundled Caddy");
