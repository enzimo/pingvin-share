import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { hash } from "argon2";
import { createReadStream } from "node:fs";
import { gzipSync } from "node:zlib";

const directory = mkdtempSync(join(tmpdir(), "pingvin-admin-files-"));
const dataDirectory = join(directory, "data");
const url = `file:${join(directory, "test.db")}?connection_limit=1`;
const prisma = new PrismaClient({ datasources: { db: { url } } });
const environment = {
  ...process.env,
  DATABASE_URL: url,
  DATA_DIRECTORY: dataDirectory,
  CONFIG_FILE: join(directory, "absent.yaml"),
  NODE_ENV: "production",
};
let application: ChildProcess;
let base: string;
let admin = new Map<string, string>();
let owner = new Map<string, string>();
let ownerId: string;
let logs = "";
let passwordHash: string;

const objects = new Map<string, Buffer>();
const multiparts = new Map<
  string,
  { key: string; parts: Map<number, Buffer> }
>();
const s3 = createServer(async (request, response) => {
  const address = new URL(request.url!, "http://localhost");
  const key = decodeURIComponent(address.pathname.replace(/^\/test\//, ""));
  const body: Buffer[] = [];
  for await (const chunk of request) body.push(Buffer.from(chunk));
  response.setHeader("Content-Type", "application/xml");
  const uploadId = address.searchParams.get("uploadId");
  if (request.method === "POST" && address.searchParams.has("uploads")) {
    const id = randomUUID();
    multiparts.set(id, { key, parts: new Map() });
    response.end(
      `<InitiateMultipartUploadResult><Bucket>test</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    );
  } else if (request.method === "PUT" && uploadId) {
    multiparts
      .get(uploadId)!
      .parts.set(
        Number(address.searchParams.get("partNumber")),
        Buffer.concat(body),
      );
    response.setHeader("ETag", '"test-part"');
    response.end();
  } else if (request.method === "POST" && uploadId) {
    const upload = multiparts.get(uploadId)!;
    objects.set(
      upload.key,
      Buffer.concat(
        [...upload.parts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map((part) => part[1]),
      ),
    );
    multiparts.delete(uploadId);
    response.end(
      `<CompleteMultipartUploadResult><Bucket>test</Bucket><Key>${key}</Key><ETag>"test"</ETag></CompleteMultipartUploadResult>`,
    );
  } else if (request.method === "DELETE" && uploadId) {
    multiparts.delete(uploadId);
    response.statusCode = 204;
    response.end();
  } else if (address.searchParams.has("list-type")) {
    const prefix = address.searchParams.get("prefix") || "";
    response.end(
      `<ListBucketResult><Name>test</Name><IsTruncated>false</IsTruncated>${[
        ...objects,
      ]
        .filter(([name]) => name.startsWith(prefix))
        .map(
          ([name, bytes]) =>
            `<Contents><Key>${name}</Key><Size>${bytes.length}</Size></Contents>`,
        )
        .join("")}</ListBucketResult>`,
    );
  } else if (objects.has(key)) {
    response.setHeader("Content-Length", objects.get(key)!.length);
    response.end(request.method === "HEAD" ? undefined : objects.get(key));
  } else {
    response.statusCode = 404;
    response.end("<Error><Code>NoSuchKey</Code></Error>");
  }
});

async function request(
  path: string,
  {
    jar = admin,
    method = "GET",
    body,
    raw = false,
  }: {
    jar?: Map<string, string>;
    method?: string;
    body?: unknown;
    raw?: boolean;
  } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
      ...(body === undefined
        ? {}
        : {
            "Content-Type": raw
              ? "application/octet-stream"
              : "application/json",
          }),
    },
    body:
      body === undefined
        ? undefined
        : raw
          ? (body as Buffer)
          : JSON.stringify(body),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [name, ...value] = cookie.split(";")[0].split("=");
    jar.set(name, value.join("="));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  let data: any;
  try {
    data = JSON.parse(bytes.toString());
  } catch {
    data = bytes;
  }
  return { status: response.status, data, bytes };
}

const append = (
  shareId: string,
  name: string,
  contents: string,
  options: {
    jar?: Map<string, string>;
    id?: string;
    index?: number;
    chunks?: number;
  } = {},
) =>
  request(
    `/api/admin/shares/${shareId}/files?${new URLSearchParams({
      name,
      id: options.id || randomUUID(),
      chunkIndex: String(options.index ?? 0),
      totalChunks: String(options.chunks ?? 1),
    })}`,
    {
      method: "POST",
      raw: true,
      body: Buffer.from(contents),
      jar: options.jar || admin,
    },
  );

async function fixture({
  size = 1,
  storage = "LOCAL",
  reverseLimit,
  ...overrides
}: {
  size?: number;
  storage?: string;
  reverseLimit?: number;
  expiration?: Date;
  removedReason?: string;
  uploadLocked?: boolean;
  creatorId?: string | null;
} = {}) {
  const shareId = `admin-${randomUUID()}`;
  const fileId = randomUUID();
  const reverse =
    reverseLimit === undefined
      ? undefined
      : await prisma.reverseShare.create({
          data: {
            creatorId: ownerId,
            shareExpiration: new Date(Date.now() + 86_400_000),
            maxShareSize: String(reverseLimit),
            remainingUses: 0,
            sendEmailNotification: true,
          },
        });
  const share = await prisma.share.create({
    data: {
      id: shareId,
      creatorId: ownerId,
      expiration: new Date(0),
      uploadLocked: true,
      storageProvider: storage,
      views: 3,
      reverseShareId: reverse?.id,
      security: { create: { password: passwordHash, maxViews: 10 } },
      recipients: { create: { email: "recipient@example.invalid" } },
      files: {
        create: { id: fileId, name: "original.txt", size: String(size) },
      },
      ...overrides,
    },
    include: { files: true, security: true, recipients: true },
  });
  const path = join(dataDirectory, "uploads/shares", shareId);
  mkdirSync(path, { recursive: true });
  if (storage === "LOCAL") writeFileSync(join(path, fileId), "a".repeat(size));
  else objects.set(`${shareId}/original.txt`, Buffer.from("a".repeat(size)));
  return { share, path, reverse };
}

function zipContents(path: string) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))",
        path,
      ],
      { encoding: "utf8" },
    ),
  );
}

async function waitForZip(shareId: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const share = await prisma.share.findUniqueOrThrow({
      where: { id: shareId },
    });
    if (share.isZipReady) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("ZIP was not prepared");
}

before(async () => {
  passwordHash = await hash("share-test-password");
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { env: environment, stdio: "pipe" },
  );
  execFileSync(process.execPath, ["dist/prisma/seed/config.seed.js"], {
    env: environment,
    stdio: "pipe",
  });
  await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", resolve));
  const s3Port = (s3.address() as { port: number }).port;
  for (const [category, name, value] of [
    ["share", "chunkSize", "4"],
    ["share", "maxSize", "14"],
    ["share", "allowUnauthenticatedShares", "true"],
    ["s3", "endpoint", `http://127.0.0.1:${s3Port}`],
    ["s3", "region", "us-east-1"],
    ["s3", "bucketName", "test"],
    ["s3", "key", "synthetic-key"],
    ["s3", "secret", "synthetic-secret"],
  ])
    await prisma.config.update({
      where: { name_category: { category, name } },
      data: { value },
    });
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  application = spawn(process.execPath, ["dist/src/main.js"], {
    env: { ...environment, BACKEND_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  application.stdout!.on("data", (data) => {
    logs += data;
  });
  application.stderr!.on("data", (data) => {
    logs += data;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {}
    if (application.exitCode !== null || attempt === 99) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const [username, jar] of [
    ["admin", admin],
    ["owner", owner],
  ] as const) {
    const created = await request("/api/auth/signUp", {
      jar,
      method: "POST",
      body: {
        username,
        email: `${username}@example.invalid`,
        password: "Disposable-test-password-123",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
  }
  ownerId = (await request("/api/users/me", { jar: owner })).data.id;
});

after(async () => {
  if (application && application.exitCode === null) {
    application.kill("SIGTERM");
    await new Promise<void>((resolve) =>
      application.once("exit", () => resolve()),
    );
  }
  s3.closeAllConnections();
  await new Promise<void>((resolve) => s3.close(() => resolve()));
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

test("only an authenticated administrator can read upload context or append files", async () => {
  const { share } = await fixture();
  for (const jar of [new Map(), owner]) {
    const expected = jar === owner ? 403 : 401;
    assert.equal(
      (await request(`/api/admin/shares/${share.id}/files`, { jar })).status,
      expected,
    );
    assert.equal(
      (await append(share.id, "new.txt", "b", { jar })).status,
      expected,
    );
  }
  assert.equal(
    (await request(`/api/admin/shares/${share.id}/files`)).status,
    200,
  );
});

test("chunked admin uploads keep the share completed and preserve policy while rebuilding its ZIP", async () => {
  const { share, path } = await fixture({ size: 8 });
  const visitor = new Map<string, string>();
  assert.equal(
    (
      await request(`/api/shares/${share.id}/token`, {
        jar: visitor,
        method: "POST",
        body: { password: "share-test-password" },
      })
    ).status,
    200,
  );
  share.views++;
  const id = randomUUID();
  assert.equal(
    (await append(share.id, "new.txt", "extr", { id, chunks: 2 })).status,
    201,
  );
  assert.equal(
    (await prisma.share.findUniqueOrThrow({ where: { id: share.id } }))
      .uploadLocked,
    true,
  );
  assert.equal(
    (await request(`/api/shares/${share.id}/from-owner`, { jar: owner }))
      .status,
    200,
  );
  assert.equal(
    (await request(`/api/shares/${share.id}`, { jar: visitor })).status,
    200,
  );
  const done = await append(share.id, "new.txt", "a", {
    id,
    index: 1,
    chunks: 2,
  });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  await waitForZip(share.id);
  const updated = await prisma.share.findUniqueOrThrow({
    where: { id: share.id },
    include: { files: true, security: true, recipients: true },
  });
  assert.equal(updated.files.length, 2);
  assert.equal(updated.uploadLocked, true);
  assert.equal(updated.isZipReady, true);
  for (const field of ["id", "creatorId", "views", "storageProvider"] as const)
    assert.equal(updated[field], share[field]);
  assert.equal(updated.expiration.getTime(), share.expiration.getTime());
  assert.deepEqual(updated.security, share.security);
  assert.deepEqual(updated.recipients, share.recipients);
  assert.deepEqual(zipContents(join(path, "archive.zip")), {
    "original.txt": "aaaaaaaa",
    "new.txt": "extra",
  });
  const download = await request(
    `/api/shares/${share.id}/files/${done.data.id}`,
    { jar: visitor },
  );
  assert.equal(download.status, 200);
  assert.equal(download.bytes.toString(), "extra");
});

test("overwrites and malformed chunks fail without changing existing files", async () => {
  const { share, path } = await fixture();
  assert.equal((await append(share.id, "original.txt", "b")).status, 409);
  assert.equal(
    (await append(share.id, "other.txt", "b", { id: share.files[0].id }))
      .status,
    409,
  );
  for (const options of [
    { index: -1 },
    { index: 1, chunks: 1 },
    { chunks: 0 },
    { chunks: 2 },
  ])
    assert.equal((await append(share.id, "bad.txt", "b", options)).status, 400);
  assert.equal(readFileSync(join(path, share.files[0].id), "utf8"), "a");
  assert.equal(await prisma.file.count({ where: { shareId: share.id } }), 1);
});

test("concurrent admin uploads obey the total limit and the final ZIP includes every accepted file", async () => {
  const { share, path } = await fixture({ size: 8 });
  const results = await Promise.all([
    append(share.id, "one.txt", "bbbb"),
    append(share.id, "two.txt", "cccc"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 413]);
  assert.equal((await append(share.id, "last.txt", "d")).status, 201);
  await waitForZip(share.id);
  const contents = zipContents(join(path, "archive.zip"));
  assert.equal(Object.keys(contents).length, 3);
  assert.equal(contents["original.txt"], "aaaaaaaa");
  assert.equal(contents["last.txt"], "d");
});

test("partial uploads count toward the limit and can resume after a rejected addition", async () => {
  const { share } = await fixture({ size: 8 });
  const id = randomUUID();
  assert.equal(
    (await append(share.id, "partial.txt", "bbbb", { id, chunks: 2 })).status,
    201,
  );
  const replay = await append(share.id, "partial.txt", "bbbb", {
    id,
    chunks: 2,
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.data.error, "unexpected_chunk_index");
  assert.equal(replay.data.expectedChunkIndex, 1);
  assert.equal((await append(share.id, "too-big.txt", "ccc")).status, 413);
  assert.equal(
    (await append(share.id, "partial.txt", "d", { id, index: 1, chunks: 2 }))
      .status,
    201,
  );
});

test("reverse-share additions retain their limit and do not consume uses or rerun completion", async () => {
  const { share, reverse } = await fixture({ reverseLimit: 3 });
  assert.equal((await append(share.id, "large.txt", "bbb")).status, 413);
  const added = await append(share.id, "small.txt", "bb");
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await waitForZip(share.id);
  assert.equal(
    (
      await prisma.reverseShare.findUniqueOrThrow({
        where: { id: reverse!.id },
      })
    ).remainingUses,
    0,
  );
  assert.equal(
    (
      await request(`/api/reverseShares/${reverse!.id}`, {
        method: "DELETE",
        jar: owner,
      })
    ).status,
    200,
  );
  assert.equal(await prisma.share.count({ where: { id: share.id } }), 0);
});

test("missing, expired, removed and unfinished shares cannot receive admin additions", async () => {
  assert.equal((await append("missing", "new.txt", "a")).status, 404);
  for (const override of [
    { expiration: new Date(1) },
    { removedReason: "malicious" },
    { uploadLocked: false },
  ]) {
    const { share } = await fixture(override);
    assert.equal(
      (await append(share.id, "new.txt", "a")).status,
      override.uploadLocked === false ? 409 : 404,
    );
  }
});

test("S3 additions use the share's provider when the global setting is local", async () => {
  const { share } = await fixture({ storage: "S3", size: 8 });
  const id = randomUUID();
  assert.equal(
    (await append(share.id, "cloud.txt", "clou", { id, chunks: 2 })).status,
    201,
  );
  const replay = await append(share.id, "cloud.txt", "clou", { id, chunks: 2 });
  assert.equal(replay.status, 400);
  assert.equal(replay.data.expectedChunkIndex, 1);
  const added = await append(share.id, "cloud.txt", "d", {
    id,
    index: 1,
    chunks: 2,
  });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await waitForZip(share.id);
  assert.equal(objects.get(`${share.id}/original.txt`)!.toString(), "aaaaaaaa");
  assert.equal(objects.get(`${share.id}/cloud.txt`)!.toString(), "cloud");
  assert.equal((await append(share.id, "cloud.txt", "x")).status, 409);
  const context = await request(`/api/admin/shares/${share.id}/files`);
  assert.equal(context.data.size, 13);
  assert.deepEqual(context.data.fileNames.sort(), [
    "cloud.txt",
    "original.txt",
  ]);
  const visitor = new Map<string, string>();
  assert.equal(
    (
      await request(`/api/shares/${share.id}/token`, {
        jar: visitor,
        method: "POST",
        body: { password: "share-test-password" },
      })
    ).status,
    200,
  );
  const download = await request(
    `/api/shares/${share.id}/files/${added.data.id}`,
    { jar: visitor },
  );
  assert.equal(download.status, 200);
  assert.equal(download.bytes.toString(), "cloud");
  const archive = await request(`/api/shares/${share.id}/files/zip`, {
    jar: visitor,
  });
  assert.equal(archive.status, 200);
  const zipPath = join(directory, "s3.zip");
  writeFileSync(zipPath, archive.bytes);
  assert.deepEqual(zipContents(zipPath), {
    "original.txt": "aaaaaaaa",
    "cloud.txt": "cloud",
  });
});

test("administrators can add to anonymous shares", async () => {
  const { share } = await fixture({ creatorId: null });
  assert.equal((await append(share.id, "new.txt", "b")).status, 201);
  assert.equal(
    (await prisma.share.findUniqueOrThrow({ where: { id: share.id } }))
      .creatorId,
    null,
  );
});

test("empty files can be added to both local and S3 shares", async () => {
  for (const storage of ["LOCAL", "S3"]) {
    const { share } = await fixture({ storage });
    const added = await append(share.id, "empty.txt", "");
    assert.equal(added.status, 201, JSON.stringify(added.data));
    assert.equal(
      (await prisma.file.findUniqueOrThrow({ where: { id: added.data.id } }))
        .size,
      "0",
    );
  }
});

test("local additions and reverse-share cleanup still use local storage after S3 is enabled", async () => {
  assert.equal(
    (
      await request("/api/configs/admin", {
        method: "PATCH",
        body: [{ key: "s3.enabled", value: true }],
      })
    ).status,
    200,
  );
  const { share, path, reverse } = await fixture({ reverseLimit: 14 });
  assert.equal((await append(share.id, "local.txt", "b")).status, 201);
  await waitForZip(share.id);
  assert.deepEqual(zipContents(join(path, "archive.zip")), {
    "original.txt": "a",
    "local.txt": "b",
  });
  assert.equal(
    (
      await request(`/api/reverseShares/${reverse!.id}`, {
        method: "DELETE",
        jar: owner,
      })
    ).status,
    200,
  );
  assert.equal(await prisma.share.count({ where: { id: share.id } }), 0);
});

test("malware scanning streams only the added file, ignoring partial and archive files", async () => {
  const { share, path } = await fixture();
  const added = await prisma.file.create({
    data: { shareId: share.id, name: "scan.txt", size: "5" },
  });
  writeFileSync(join(path, added.id), "check");
  writeFileSync(join(path, "unfinished.tmp-chunk"), "not committed");
  writeFileSync(join(path, "archive.zip"), "not a file to scan");
  const { ClamScanService } =
    await import("../dist/src/clamscan/clamscan.service.js");
  const checked: string[] = [];
  const service = Object.assign(Object.create(ClamScanService.prototype), {
    prisma,
    fileService: {
      get: async (_shareId: string, id: string) => ({
        file: createReadStream(join(path, id)),
      }),
    },
    ClamScan: Promise.resolve({
      scanStream: async (stream: AsyncIterable<Buffer>) => {
        const buffers = [];
        for await (const buffer of stream) buffers.push(buffer);
        checked.push(Buffer.concat(buffers).toString());
        return { isInfected: false };
      },
    }),
  });
  assert.deepEqual(await service.check(share.id, [added.id]), []);
  assert.deepEqual(checked, ["check"]);
});

test("malformed compressed requests do not crash the public API", async () => {
  const response = await fetch(base + "/api/auth/signIn", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body: Buffer.concat([
      gzipSync(
        Buffer.from(
          JSON.stringify({
            email: "unknown@example.invalid",
            password: "wrong",
          }),
        ),
      ),
      Buffer.from("invalid trailing compressed bytes"),
    ]),
  });
  await response.arrayBuffer();
  assert.ok([400, 401].includes(response.status));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await fetch(base + "/api/health")).status, 200);
});

test("background ZIP work coalesces additions and only marks the latest file list ready", async () => {
  const { share } = await fixture();
  const { ShareService } = await import("../dist/src/share/share.service.js");
  let start: () => void;
  let finish: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let builds = 0;
  const service = Object.assign(Object.create(ShareService.prototype), {
    prisma,
    zipCreations: new Map(),
    writeZip: async () => {
      const files = await prisma.file.findMany({
        where: { shareId: share.id },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      if (++builds === 1) {
        start();
        await paused;
      }
      return files.map((file) => file.id);
    },
  });
  const initial = service.createZip(share.id);
  await started;
  await prisma.$transaction([
    prisma.file.delete({ where: { id: share.files[0].id } }),
    prisma.file.create({
      data: { shareId: share.id, name: "concurrent.txt", size: "1" },
    }),
    prisma.share.update({
      where: { id: share.id },
      data: { isZipReady: false },
    }),
  ]);
  const coalesced = service.createZip(share.id);
  assert.equal(
    (await prisma.share.findUniqueOrThrow({ where: { id: share.id } }))
      .isZipReady,
    false,
  );
  finish();
  await Promise.all([initial, coalesced]);
  assert.equal(builds, 2);
  assert.equal(
    (await prisma.share.findUniqueOrThrow({ where: { id: share.id } }))
      .isZipReady,
    true,
  );
});
