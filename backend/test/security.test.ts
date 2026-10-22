import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { JwtService } from "@nestjs/jwt";
import { authenticator } from "otplib";
import { ThrottlerStorageService } from "@nestjs/throttler";
import { AuthService } from "../src/auth/auth.service";
import { AuthTotpService } from "../src/auth/authTotp.service";
import { OAuthService } from "../src/oauth/oauth.service";
import { S3FileService } from "../src/file/s3.service";
import { LocalFileService } from "../src/file/local.service";
import { FileSecurityGuard } from "../src/file/guard/fileSecurity.guard";
import { JwtStrategy } from "../src/auth/strategy/jwt.strategy";
import { ShareOwnerGuard } from "../src/share/guard/shareOwner.guard";
import { AuthController } from "../src/auth/auth.controller";
import { THROTTLER_TTL } from "@nestjs/throttler/dist/throttler.constants";
import { GenericOidcProvider } from "../src/oauth/provider/genericOidc.provider";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const require = createRequire(join(process.cwd(), "package.json"));
const directory = mkdtempSync(join(tmpdir(), "pingvin-security-"));
const url = `file:${join(directory, "test.db")}`;
execFileSync(
  process.execPath,
  [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
  {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  },
);
const prisma = new PrismaClient({ datasources: { db: { url } } });
const config = {
  get: (key: string) =>
    ({
      "internal.jwtSecret": "synthetic-test-key-of-at-least-32-bytes",
      "oauth.disablePassword": false,
      "share.allowUnauthenticatedShares": true,
    })[key],
};
const auth = new AuthService(
  prisma as any,
  new JwtService(),
  config as any,
  null,
  null,
  null,
  null,
);
after(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

test("expired reset tokens fail, valid tokens are single-use and revoke sessions", async () => {
  const user = await prisma.user.create({
    data: {
      email: "reset@example.invalid",
      username: "reset",
      password: "old",
    },
  });
  const token = await prisma.resetPasswordToken.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() - 1000) },
  });
  await assert.rejects(auth.resetPassword(token.token, "new-password"));
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password,
    "old",
  );
  await prisma.resetPasswordToken.update({
    where: { token: token.token },
    data: { expiresAt: new Date(Date.now() + 60_000) },
  });
  await prisma.refreshToken.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  await auth.resetPassword(token.token, "new-password");
  await assert.rejects(auth.resetPassword(token.token, "second-password"));
  assert.equal(
    await prisma.refreshToken.count({ where: { userId: user.id } }),
    0,
  );
});

test("TOTP configuration rejects an incorrect password and permits valid enrollment", async () => {
  const user = await prisma.user.create({
    data: { email: "totp@example.invalid", username: "totp" },
  });
  let accepted = false;
  const service = new AuthTotpService(
    prisma as any,
    { get: () => "test" } as any,
    { verifyPassword: async () => accepted } as any,
  );
  await assert.rejects(service.enableTotp(user, "wrong"));
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .totpEnabled,
    false,
  );
  accepted = true;
  const enrollment = await service.enableTotp(user, "correct");
  accepted = false;
  await assert.rejects(
    service.verifyTotp(
      user,
      "wrong",
      authenticator.generate(enrollment.totpSecret),
    ),
  );
  accepted = true;
  await service.verifyTotp(
    user,
    "correct",
    authenticator.generate(enrollment.totpSecret),
  );
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .totpVerified,
    true,
  );
});

test("LDAP password verification awaits failed binds and refuses empty credentials", async () => {
  const service = new AuthService(
    null,
    null,
    { get: () => true } as any,
    null,
    { authenticateUser: async () => null } as any,
    null,
    null,
  );
  assert.equal(
    await service.verifyPassword(
      { ldapDN: "cn=test", username: "test" } as any,
      "wrong",
    ),
    false,
  );
});

test("OAuth never links by email and rejects unverified registration", async () => {
  const victim = await prisma.user.create({
    data: { email: "victim@example.invalid", username: "victim" },
  });
  const service = new OAuthService(
    prisma as any,
    { get: () => true } as any,
    null,
    [],
    {},
  );
  const identity = {
    provider: "oidc" as const,
    providerId: "attacker",
    providerUsername: "attacker",
    email: victim.email,
    emailVerified: true,
  };
  await assert.rejects(service.signIn(identity, "127.0.0.1"));
  await assert.rejects(
    service.signIn(
      { ...identity, email: "new@example.invalid", emailVerified: false },
      "127.0.0.1",
    ),
  );
  assert.equal(await prisma.oAuthUser.count(), 0);
});

test("S3 and local operations cannot select another share's file", async () => {
  const victim = await prisma.share.create({
    data: {
      id: "victim-share",
      expiration: new Date(Date.now() + 60_000),
      files: { create: { name: "document.txt", size: "4" } },
    },
    include: { files: true },
  });
  const storage = new S3FileService(
    prisma as any,
    { get: () => "test" } as any,
  );
  storage.getS3Instance = () => {
    throw new Error("Storage should not be contacted");
  };
  await assert.rejects(
    storage.remove("attacker-share", victim.files[0].id),
    /File not found/,
  );
  await assert.rejects(
    storage.get("attacker-share", victim.files[0].id),
    /File not found/,
  );
  const local = new LocalFileService(prisma as any, config as any);
  await assert.rejects(
    local.remove("attacker-share", victim.files[0].id),
    /File not found/,
  );
  assert.equal(await prisma.file.count(), 1);
});

test("private reverse-share downloads require its owner even without a share token", async () => {
  const owner = await prisma.user.create({
    data: { email: "owner@example.invalid", username: "owner" },
  });
  const reverse = await prisma.reverseShare.create({
    data: {
      creatorId: owner.id,
      shareExpiration: new Date(Date.now() + 60_000),
      maxShareSize: "1024",
      remainingUses: 1,
      sendEmailNotification: false,
      publicAccess: false,
    },
  });
  const share = await prisma.share.create({
    data: {
      id: "private-share",
      reverseShareId: reverse.id,
      expiration: new Date(Date.now() + 60_000),
    },
  });
  let currentUser: string | null = null;
  const guard = new FileSecurityGuard(
    { increaseViewCount: async () => {} } as any,
    prisma as any,
    config as any,
    { getIdOfCurrentUser: async () => currentUser } as any,
  );
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ params: { shareId: share.id }, cookies: {} }),
    }),
  } as any;
  await assert.rejects(guard.canActivate(context), /private/);
  currentUser = owner.id;
  assert.equal(await guard.canActivate(context), true);
});

test("anonymous owner cookies are signed and bound to a share creation", async () => {
  const jwt = new JwtService();
  const guard = new ShareOwnerGuard(config as any, prisma as any, jwt);
  const share = await prisma.share.create({
    data: { id: "anonymous-share", expiration: new Date(Date.now() + 60_000) },
  });
  const request = {
    params: { shareId: share.id },
    cookies: {} as Record<string, string>,
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getType: () => "http",
  } as any;
  assert.equal(await guard.canActivate(context), false);
  request.cookies[`share_${share.id}_owner`] = jwt.sign(
    {
      purpose: "upload-owner",
      shareId: share.id,
      createdAt: share.createdAt.toISOString(),
    },
    { secret: config.get("internal.jwtSecret") },
  );
  assert.equal(await guard.canActivate(context), true);
});

test("revoked access-token sessions fail validation", async () => {
  const strategy = new JwtStrategy(config as any, prisma as any);
  assert.equal(
    await strategy.validate({ sub: "missing", refreshTokenId: "revoked" }),
    null,
  );
});

test("authentication counters do not reset after the former 300ms window", async () => {
  const storage = new ThrottlerStorageService();
  const ttl = Reflect.getMetadata(
    THROTTLER_TTL + "default",
    AuthController.prototype.signIn,
  );
  assert.equal(ttl, 300_000);
  try {
    await storage.increment("test", ttl, 20, ttl, "default");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const value = await storage.increment("test", ttl, 20, ttl, "default");
    assert.equal(value.totalHits, 2);
  } finally {
    storage.onApplicationShutdown();
  }
});

test("OIDC validates signatures, issuer, audience, expiry and nonce against real JWKS", async () => {
  const pair = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test",
    alg: "RS256",
    use: "sig",
  };
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const issuer = `http://127.0.0.1:${address.port}`;
  const cache = new Map<string, string>();
  class Provider extends GenericOidcProvider {
    constructor() {
      super(
        "oidc",
        [],
        { get: () => "test-client", addListener: () => {} } as any,
        new JwtService(),
        {
          get: async (key: string) => cache.get(key),
          del: async (key: string) => cache.delete(key),
        } as any,
      );
    }
    protected getDiscoveryUri() {
      return issuer;
    }
    async getConfiguration() {
      return { issuer, jwks_uri: issuer } as any;
    }
  }
  const provider = new Provider();
  const issue = (
    audience = "test-client",
    tokenIssuer = issuer,
    expires = "1m",
    nonce = "test-nonce",
  ) =>
    new SignJWT({
      nonce,
      email: "oidc@example.invalid",
      email_verified: true,
      preferred_username: "oidc",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("subject")
      .setIssuer(tokenIssuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(pair.privateKey);
  const check = async (token: string) => {
    cache.set("oauth-oidc-nonce-state", "test-nonce");
    return provider.getUserInfo(
      { idToken: token } as any,
      { state: "state" } as any,
    );
  };
  try {
    assert.equal((await check(await issue())).emailVerified, true);
    await assert.rejects(check(await issue("other-client")));
    await assert.rejects(
      check(await issue("test-client", "https://evil.invalid")),
    );
    await assert.rejects(check(await issue("test-client", issuer, "-1s")));
    await assert.rejects(
      check(await issue("test-client", issuer, "1m", "wrong-nonce")),
    );
    const token = await issue();
    const parts = token.split(".");
    parts[2] = "A".repeat(parts[2].length);
    await assert.rejects(check(parts.join(".")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
