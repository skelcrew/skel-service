// Tests of skel's service through its fetch handler, as GitHub and the GitHub plugin reach it,
// with GitHub faked and a Map standing in for Workers KV.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import service, { type Env } from "../src/index.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// What the fake GitHub was asked, in order.
type Asked = { method: string; url: string; auth: string | null; body: string };
let asked: Asked[] = [];
// The fake GitHub's answer to a request, by method and URL, or undefined for a 404.
let answer: (method: string, url: string, auth: string | null) => Response | undefined;
const realFetch = globalThis.fetch;
let limited: Set<string>;
let store: Map<string, string>;
let written: Map<string, number>;
let waiting: Promise<unknown>[];

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// A GitHub where simon signs in with "user-token", can push to simon/app, can only read
// simon/public, and the app is installed on both but not on simon/other. Its owner, ada,
// signs in with "owner-token" and can push to simon/public.
function github(method: string, url: string, auth: string | null): Response | undefined {
  if (url === "https://api.github.com/user") {
    if (auth === "Bearer user-token") return json({ id: 7, login: "simon" });
    if (auth === "Bearer owner-token") return json({ id: 8, login: "ada" });
    return json({}, 401);
  }
  const repo = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/)?.[1];
  if (repo === "simon/public" && auth === "Bearer owner-token")
    return json({ full_name: "simon/public", name: "public", permissions: { push: true } });
  if (repo && auth === "Bearer user-token") {
    if (repo === "simon/app")
      return json({ full_name: "simon/App", name: "App", permissions: { push: true } });
    if (repo === "simon/public")
      return json({ full_name: "simon/public", name: "public", permissions: { push: false } });
    if (repo === "simon/other")
      return json({ full_name: "simon/other", name: "other", permissions: { push: true } });
  }
  if (url === "https://api.github.com/repos/simon/App/installation") return json({ id: 41 });
  if (url === "https://api.github.com/repos/simon/public/installation") return json({ id: 41 });
  if (method === "POST" && url === "https://api.github.com/app/installations/41/access_tokens")
    return json({ token: "ghs_repo", expires_at: "2026-11-09T19:00:00Z" }, 201);
  if (method === "POST" && url === "https://github.com/login/oauth/access_token") return undefined;
  return undefined;
}

beforeEach(() => {
  asked = [];
  answer = github;
  limited = new Set();
  store = new Map();
  written = new Map();
  waiting = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const auth = request.headers.get("authorization");
      asked.push({ method: request.method, url: request.url, auth, body: await request.text() });
      return answer(request.method, request.url, auth) ?? json({ message: "Not Found" }, 404);
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const env: Env = {
  APP_ID: "1234",
  APP_SLUG: "skelcrew",
  PRIVATE_KEY: privateKey,
  CLIENT_ID: "Iv1.client",
  CLIENT_SECRET: "client-secret",
  WEBHOOK_SECRET: "webhook-secret",
  WAKE: {
    get: async (key) => store.get(key) ?? null,
    // Workers KV refuses a second write to one key within a second.
    put: async (key, value) => {
      if (Date.now() - (written.get(key) ?? 0) < 1000) throw new Error("KV PUT failed: 429");
      written.set(key, Date.now());
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    // As Workers KV lists: the keys that start with the prefix, in order, at most 1000.
    list: async ({ prefix }) => ({
      keys: [...store.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort()
        .slice(0, 1000)
        .map((name) => ({ name })),
    }),
  },
  LIMIT: { limit: async ({ key }) => ({ success: !limited.has(key) }) },
};

const context = { waitUntil: (promise: Promise<unknown>) => void waiting.push(promise) };

// Sends a request to the service, as the plugin or GitHub would.
async function send(path: string, init: RequestInit = {}) {
  const response = await service.fetch(
    new Request(`https://skelcrew.dev${path}`, init),
    env,
    context,
  );
  await Promise.all(waiting);
  return response;
}

const asUser = (body: object, token = "user-token"): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("the service names the app's install page and its client ID", async () => {
  const response = await send("/github");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    install: "https://github.com/apps/skelcrew/installations/new",
    client_id: "Iv1.client",
  });
});

test("a token works for one repository, and is made with the app's signed JWT", async () => {
  const response = await send("/github/token", asUser({ repository: "simon/app" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ token: "ghs_repo", expires: "2026-11-09T19:00:00Z" });
  const made = asked.find((a) => a.url.endsWith("/access_tokens"));
  expect(JSON.parse(made?.body ?? "")).toEqual({ repositories: ["App"] });
  // The JWT verifies with the app's public key, and names the app.
  const jwt = (made?.auth ?? "").replace("Bearer ", "");
  const [header = "", claims = "", signature = ""] = jwt.split(".");
  const signed = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    createPublicKey(publicKey),
    Buffer.from(signature, "base64url"),
  );
  expect(signed).toBe(true);
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  const said = JSON.parse(Buffer.from(claims, "base64url").toString());
  expect(said.iss).toBe("1234");
  expect(said.exp - said.iat).toBeLessThanOrEqual(600);
});

test("a key in the PKCS#8 form GitHub doesn't give works too", async () => {
  const pkcs8 = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const response = await service.fetch(
    new Request("https://skelcrew.dev/github/token", asUser({ repository: "simon/app" })),
    { ...env, PRIVATE_KEY: pkcs8.privateKey },
    context,
  );
  expect(response.status).toBe(200);
});

test("someone who can't push to the repository gets a token that only reads", async () => {
  const response = await send("/github/token", asUser({ repository: "simon/public" }));
  expect(response.status).toBe(200);
  const made = asked.find((a) => a.url.endsWith("/access_tokens"));
  const body = JSON.parse(made?.body ?? "");
  expect(body.repositories).toEqual(["public"]);
  expect(Object.values(body.permissions)).toEqual(Array(7).fill("read"));
});

test("a repository's name may hold two dots in a row", async () => {
  answer = (method, url, auth) =>
    url === "https://api.github.com/repos/simon/app..test"
      ? json({ full_name: "simon/app..test", name: "app..test", permissions: { push: true } })
      : github(method, url, auth);
  const response = await send("/github/token", asUser({ repository: "simon/app..test" }));
  expect(response.status).toBe(404);
  expect(await response.text()).toContain(
    "Skelcrew's GitHub App isn't installed on simon/app..test",
  );
});

test("no token for a repository you can't reach", async () => {
  const response = await send("/github/token", asUser({ repository: "simon/secret" }));
  expect(response.status).toBe(404);
  expect(asked.some((a) => a.url.endsWith("/access_tokens"))).toBe(false);
});

test("no token where the app isn't installed, and the answer says where to install it", async () => {
  const response = await send("/github/token", asUser({ repository: "simon/other" }));
  expect(response.status).toBe(404);
  expect(await response.text()).toContain("https://github.com/apps/skelcrew/installations/new");
  expect(asked.some((a) => a.url.endsWith("/access_tokens"))).toBe(false);
});

test("no token without a sign-in GitHub accepts", async () => {
  expect((await send("/github/token", asUser({ repository: "simon/app" }, "stale"))).status).toBe(
    401,
  );
  const unsigned = { method: "POST", body: JSON.stringify({ repository: "simon/app" }) };
  expect((await send("/github/token", unsigned)).status).toBe(401);
});

test("a request that isn't what the service takes is refused", async () => {
  expect((await send("/github/token", asUser({ repository: "../x" }))).status).toBe(400);
  expect((await send("/github/token", asUser({ repository: "simon/.." }))).status).toBe(400);
  expect((await send("/github/token", { ...asUser({}), body: "not json" })).status).toBe(400);
  expect((await send("/nothing")).status).toBe(404);
});

test("GitHub failing for a while asks you to try again, and never to sign in again", async () => {
  const down = (path: string) => (method: string, url: string, auth: string | null) =>
    url.endsWith(path) ? json({ message: "Server Error" }, 503) : github(method, url, auth);
  answer = down("/user");
  expect((await send("/github/token", asUser({ repository: "simon/app" }))).status).toBe(502);
  answer = down("/repos/simon/app");
  expect((await send("/github/token", asUser({ repository: "simon/app" }))).status).toBe(502);
  answer = down("/repos/simon/App/installation");
  expect((await send("/github/token", asUser({ repository: "simon/app" }))).status).toBe(502);
  answer = down("/login/oauth/access_token");
  const renewal = { method: "POST", body: JSON.stringify({ refresh_token: "ghr_old" }) };
  expect((await send("/github/renew", renewal)).status).toBe(502);
});

test("someone asking for tokens too often is told to wait", async () => {
  limited.add("user:7");
  const response = await send("/github/token", asUser({ repository: "simon/app" }));
  expect(response.status).toBe(429);
  expect(asked.some((a) => a.url.endsWith("/access_tokens"))).toBe(false);
});

test("renewing a sign-in hands GitHub the app's secret, and the new sign-in back", async () => {
  answer = (method, url, auth) =>
    url === "https://github.com/login/oauth/access_token"
      ? json({
          access_token: "ghu_new",
          expires_in: 28800,
          refresh_token: "ghr_new",
          refresh_token_expires_in: 15724800,
          token_type: "bearer",
        })
      : github(method, url, auth);
  const response = await send("/github/renew", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: "ghr_old" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    access_token: "ghu_new",
    expires_in: 28800,
    refresh_token: "ghr_new",
    refresh_token_expires_in: 15724800,
  });
  const sent = new URLSearchParams(asked.at(-1)?.body);
  expect(sent.get("client_id")).toBe("Iv1.client");
  expect(sent.get("client_secret")).toBe("client-secret");
  expect(sent.get("grant_type")).toBe("refresh_token");
  expect(sent.get("refresh_token")).toBe("ghr_old");
});

test("a refresh token GitHub refuses renews nothing", async () => {
  // GitHub answers a bad refresh token with 200 and an error.
  answer = (method, url, auth) =>
    url === "https://github.com/login/oauth/access_token"
      ? json({ error: "bad_refresh_token" })
      : github(method, url, auth);
  const response = await send("/github/renew", {
    method: "POST",
    body: JSON.stringify({ refresh_token: "ghr_spent" }),
  });
  expect(response.status).toBe(401);
});

// Signs a webhook body as GitHub does, with the app's webhook secret.
async function signed(body: string, secret = "webhook-secret"): Promise<RequestInit> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Buffer.from(mac).toString("hex");
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${hex}` }, body };
}

test("a wake-up address registered for a repository gets a bare request for each event", async () => {
  const wake = asUser({ repository: "simon/app", url: "https://demo.sprites.app/github" });
  expect((await send("/github/wake", wake)).status).toBe(204);
  const other = asUser({ repository: "simon/app", url: "https://work.example.com/github" });
  expect((await send("/github/wake", other)).status).toBe(204);
  // Registering the same address again keeps one.
  expect((await send("/github/wake", wake)).status).toBe(204);
  asked = [];
  const event = JSON.stringify({
    action: "created",
    repository: { full_name: "simon/App" },
    comment: { body: "a secret plan" },
  });
  expect((await send("/github/webhook", await signed(event))).status).toBe(204);
  expect(asked.map((a) => [a.method, a.url, a.body])).toEqual([
    ["POST", "https://demo.sprites.app/github", ""],
    ["POST", "https://work.example.com/github", ""],
  ]);
});

test("an event keeps at most six wake-ups open at once, as Workers allow", async () => {
  for (let n = 0; n < 8; n++)
    await send(
      "/github/wake",
      asUser({ repository: "simon/app", url: `https://m${n}.example.com/` }),
    );
  const github = globalThis.fetch;
  let open = 0;
  let most = 0;
  let woken = 0;
  // Each machine holds its request open a moment, as one waking from sleep does.
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith(".example.com/")) return github(input, init);
      open++;
      most = Math.max(most, open);
      await new Promise((done) => setTimeout(done, 5));
      open--;
      woken++;
      return new Response(null, { status: 204 });
    },
    { preconnect: realFetch.preconnect },
  );
  const event = JSON.stringify({ repository: { full_name: "simon/App" } });
  expect((await send("/github/webhook", await signed(event))).status).toBe(204);
  expect(woken).toBe(8);
  expect(most).toBeLessThanOrEqual(6);
});

test("an event for a repository with no address, or none at all, wakes nobody", async () => {
  await send(
    "/github/wake",
    asUser({ repository: "simon/app", url: "https://demo.sprites.app/github" }),
  );
  asked = [];
  const other = JSON.stringify({ repository: { full_name: "simon/public" } });
  expect((await send("/github/webhook", await signed(other))).status).toBe(204);
  const installation = JSON.stringify({ action: "created", installation: { id: 41 } });
  expect((await send("/github/webhook", await signed(installation))).status).toBe(204);
  expect(asked).toEqual([]);
});

test("an event that isn't signed with the app's secret is dropped", async () => {
  await send(
    "/github/wake",
    asUser({ repository: "simon/app", url: "https://demo.sprites.app/github" }),
  );
  asked = [];
  const event = JSON.stringify({ repository: { full_name: "simon/App" } });
  expect((await send("/github/webhook", await signed(event, "guess"))).status).toBe(401);
  expect((await send("/github/webhook", { method: "POST", body: event })).status).toBe(401);
  expect(asked).toEqual([]);
});

test("two machines registering at once both get woken, and removing one keeps the other", async () => {
  const first = "https://one.sprites.app/github";
  const second = "https://two.sprites.app/github";
  const [a, b] = await Promise.all([
    send("/github/wake", asUser({ repository: "simon/app", url: first })),
    send("/github/wake", asUser({ repository: "simon/app", url: second })),
  ]);
  expect([a.status, b.status]).toEqual([204, 204]);
  const event = JSON.stringify({ repository: { full_name: "simon/App" } });
  asked = [];
  await send("/github/webhook", await signed(event));
  expect(asked.map((x) => x.url).sort()).toEqual([first, second]);
  await send("/github/unwake", asUser({ repository: "simon/app", url: first }));
  asked = [];
  await send("/github/webhook", await signed(event));
  expect(asked.map((x) => x.url)).toEqual([second]);
});

test("a repository takes at most 20 wake-up addresses", async () => {
  for (let n = 0; n < 20; n++)
    await send(
      "/github/wake",
      asUser({ repository: "simon/app", url: `https://m${n}.example.com/` }),
    );
  const more = asUser({ repository: "simon/app", url: "https://m20.example.com/" });
  expect((await send("/github/wake", more)).status).toBe(400);
  const again = asUser({ repository: "simon/app", url: "https://m0.example.com/" });
  expect((await send("/github/wake", again)).status).toBe(204);
});

test("an address no longer registered gets nothing", async () => {
  const url = "https://demo.sprites.app/github";
  await send("/github/wake", asUser({ repository: "simon/app", url }));
  expect((await send("/github/unwake", asUser({ repository: "simon/app", url }))).status).toBe(204);
  asked = [];
  const event = JSON.stringify({ repository: { full_name: "simon/App" } });
  await send("/github/webhook", await signed(event));
  expect(asked).toEqual([]);
  expect(store.size).toBe(0);
});

test("only someone who can push registers a wake-up address, and only an https one", async () => {
  const url = "https://demo.sprites.app/github";
  expect((await send("/github/wake", asUser({ repository: "simon/public", url }))).status).toBe(
    403,
  );
  const plain = asUser({ repository: "simon/app", url: "http://demo.sprites.app/github" });
  expect((await send("/github/wake", plain)).status).toBe(400);
  expect(
    (await send("/github/wake", asUser({ repository: "simon/app", url }, "stale"))).status,
  ).toBe(401);
  expect(store.size).toBe(0);
});

test("only someone who can push removes a wake-up address", async () => {
  const url = "https://ada.sprites.app/github";
  expect(
    (await send("/github/wake", asUser({ repository: "simon/public", url }, "owner-token"))).status,
  ).toBe(204);
  const removal = await send("/github/unwake", asUser({ repository: "simon/public", url }));
  expect(removal.status).toBe(403);
  asked = [];
  const event = JSON.stringify({ repository: { full_name: "simon/public" } });
  await send("/github/webhook", await signed(event));
  expect(asked.map((a) => a.url)).toEqual([url]);
});

test("the service logs no request body", async () => {
  const logged: unknown[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...words: unknown[]) => void logged.push(words);
  try {
    await send(
      "/github/wake",
      asUser({ repository: "simon/app", url: "https://demo.sprites.app/x" }),
    );
    answer = (method, url, auth) =>
      url === "https://demo.sprites.app/x" ? undefined : github(method, url, auth);
    const event = JSON.stringify({ repository: { full_name: "simon/App" }, secret: "plan-x" });
    await send("/github/webhook", await signed(event));
    await send("/github/token", asUser({ repository: "simon/app" }));
  } finally {
    Object.assign(console, saved);
  }
  expect(JSON.stringify(logged)).not.toContain("plan-x");
  expect(JSON.stringify(logged)).not.toContain("user-token");
  expect(JSON.stringify(logged)).not.toContain("ghs_repo");
});
