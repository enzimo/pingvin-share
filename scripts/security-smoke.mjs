import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Run against a fresh disposable instance, never an existing production database.
const base = process.env.SMOKE_URL || "http://127.0.0.1:18080";
const admin = new Map();
const password = `Disposable-${randomUUID()}`;
const email = `smoke-${randomUUID()}@example.invalid`;
async function request(
  path,
  { method = "GET", body, jar = new Map(), headers = {} } = {},
) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [name, ...value] = cookie.split(";")[0].split("=");
    jar.set(name, value.join("="));
  }
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, headers: response.headers, data };
}

let result = await request("/api/auth/signUp", {
  method: "POST",
  jar: admin,
  body: { email, username: "smoke_admin", password },
});
assert.equal(result.status, 201, JSON.stringify(result.data));
assert.ok(
  result.headers
    .getSetCookie()
    .find(
      (cookie) =>
        cookie.startsWith("access_token=") && /httponly/i.test(cookie),
    ),
);
result = await request("/api/users/me", { jar: admin });
assert.equal(result.data.isAdmin, true);
result = await request("/api/auth/totp/enable", {
  method: "POST",
  jar: admin,
  body: { password: "wrong" },
});
assert.equal(result.status, 403);

result = await request("/api/configs/admin", {
  method: "PATCH",
  jar: admin,
  body: [{ key: "share.allowUnauthenticatedShares", value: true }],
});
assert.equal(result.status, 200, JSON.stringify(result.data));
result = await request("/api/users/me", {
  method: "PATCH",
  body: { username: "unauthorized" },
});
assert.equal(result.status, 401);
console.log(
  "PASS: authenticated account operations remain protected when anonymous uploads are enabled",
);

result = await request("/api/reverseShares", {
  method: "POST",
  jar: admin,
  body: {
    sendEmailNotification: false,
    maxShareSize: "1024",
    shareExpiration: "1-days",
    maxUseCount: 5,
    simplified: false,
    publicAccess: false,
  },
});
assert.equal(result.status, 201, JSON.stringify(result.data));
const uploader = new Map([["reverse_share_token", result.data.token]]);
const id = `smoke-${randomUUID()}`;
result = await request("/api/shares", {
  method: "POST",
  jar: uploader,
  body: {
    id,
    expiration: "1-days",
    recipients: [],
    security: {},
    description: "disposable smoke test",
  },
});
assert.equal(result.status, 201, JSON.stringify(result.data));
assert.ok(uploader.get(`share_${id}_owner`));
const contents = "security-smoke-test";
const upload = await fetch(
  `${base}/api/shares/${id}/files?name=smoke.txt&chunkIndex=0&totalChunks=1`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      cookie: [...uploader].map(([key, value]) => `${key}=${value}`).join("; "),
    },
    body: contents,
  },
);
assert.equal(upload.status, 201, await upload.clone().text());
const file = await upload.json();
result = await request(`/api/shares/${id}/complete`, {
  method: "POST",
  jar: uploader,
});
assert.equal(result.status, 202, JSON.stringify(result.data));
result = await request(`/api/shares/${id}/from-owner`);
assert.equal(result.status, 403);
result = await request(`/api/shares/${id}/files/${file.id}`);
assert.equal(result.status, 403);
result = await request(`/api/shares/${id}/files/${file.id}`, {
  method: "DELETE",
});
assert.equal(result.status, 403);
result = await request(`/api/shares/${id}/files/${file.id}`, { jar: admin });
assert.equal(result.status, 200, JSON.stringify(result.data));
assert.equal(result.data, contents);
console.log(
  "PASS: anonymous reverse upload succeeds and private metadata, downloads and deletion reject outsiders",
);

if (process.env.SMOKE_FRONTEND === "true") {
  result = await request("/_next/image?url=%2Fimg%2Flogo.png&w=640&q=75");
  assert.equal(result.status, 404);
  const home = await request("/");
  assert.ok([200, 307, 308].includes(home.status));
  console.log(
    "PASS: production frontend responds and image optimization is disabled",
  );
}

const oldSession = new Map(admin);
result = await request("/api/auth/signOut", { method: "POST", jar: admin });
assert.equal(result.status, 201);
result = await request("/api/users/me", { jar: oldSession });
assert.ok(result.data === null || result.data === "");
result = await request("/api/users/me", {
  method: "PATCH",
  jar: oldSession,
  body: { username: "revoked" },
});
assert.equal(result.status, 401);
console.log("PASS: signed-out access cookies cannot restore a revoked session");

for (let attempt = 0; attempt < 21; attempt++) {
  result = await request("/api/auth/signIn", {
    method: "POST",
    headers:
      process.env.SMOKE_FRONTEND === "true"
        ? { "X-Forwarded-For": `198.51.100.${attempt + 1}` }
        : {},
    body: { email, password: "wrong" },
  });
  if (result.status === 429) break;
  assert.equal(result.status, 401);
}
assert.equal(result.status, 429);
await new Promise((resolve) => setTimeout(resolve, 400));
result = await request("/api/auth/signIn", {
  method: "POST",
  body: { email, password: "wrong" },
});
assert.equal(result.status, 429);
console.log(
  "PASS: login throttling survives the former 300ms reset window" +
    (process.env.SMOKE_FRONTEND === "true"
      ? " and forwarded-header rotation"
      : ""),
);
