// skel's service: it holds the secrets of skel's GitHub App, so skel never has to. It makes
// tokens for one repository, renews your sign-in, and passes GitHub's events on as wake-ups.
import { appJwt, isRecord, reach, renew, repositoryToken, signedIn } from "./github.ts";

// What the Worker is given: the app's secrets, the store of wake-up addresses, and the limit
// on how often one person may ask.
export type Env = {
  APP_ID: string;
  APP_SLUG: string;
  PRIVATE_KEY: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  WEBHOOK_SECRET: string;
  WAKE: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
};

type Context = { waitUntil(promise: Promise<unknown>): void };

// More addresses than this for one repository is more machines than anyone runs, and each one
// costs a request on every event.
const mostAddresses = 20;

// Returns a JSON answer.
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// Returns an answer that says what went wrong, in words the plugin shows you.
const refuse = (status: number, error: string) => json({ error }, status);

// Returns the request's JSON body, or null when it isn't a JSON object.
async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const read: unknown = await request.json();
    return isRecord(read) ? read : null;
  } catch {
    return null;
  }
}

// Returns an owner/name a GitHub repository could have, so nothing else reaches a GitHub path.
const repositoryName = (value: unknown) =>
  typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value) && !value.includes("..")
    ? value
    : null;

// Returns a wake-up address the service will send to: https, with no login in it.
function wakeAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

// Where a repository's wake-up addresses are kept. GitHub's events name a repository as
// GitHub writes it, so the key is its name as GitHub writes it too.
const wakeKey = (fullName: string) => `wake:${fullName}`;

// Returns the addresses registered for a repository.
async function addresses(env: Env, fullName: string): Promise<string[]> {
  const stored = await env.WAKE.get(wakeKey(fullName));
  const parsed: unknown = stored ? JSON.parse(stored) : [];
  return Array.isArray(parsed) ? parsed.filter((url) => typeof url === "string") : [];
}

// Checks who is asking and what they can reach: their sign-in, how often they have asked, and
// the repository the body names. Returns the repository as they see it, with their sign-in,
// or the answer that refuses them.
async function caller(
  request: Request,
  env: Env,
): Promise<
  | { refused: Response }
  | {
      given: Record<string, unknown>;
      repository: NonNullable<Awaited<ReturnType<typeof reach>>>;
    }
> {
  const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return { refused: refuse(401, "sign in to GitHub first") };
  const given = await body(request);
  const name = repositoryName(given?.repository);
  if (!given || !name) return { refused: refuse(400, "name a repository as owner/name") };
  const user = await signedIn(token);
  if (!user) return { refused: refuse(401, "GitHub doesn't accept your sign-in") };
  if (!(await env.LIMIT.limit({ key: `user:${user.id}` })).success)
    return { refused: refuse(429, "too many requests: wait a minute") };
  const repository = await reach(token, name);
  if (!repository)
    return { refused: refuse(404, `${name} isn't on GitHub, or you can't reach it`) };
  return { given, repository };
}

// Makes a token for one repository, for an hour, for someone signed in who can reach it, where
// the app is installed. It writes only for someone who can push there.
async function token(request: Request, env: Env): Promise<Response> {
  const asked = await caller(request, env);
  if ("refused" in asked) return asked.refused;
  const { repository } = asked;
  const jwt = await appJwt(env.APP_ID, env.PRIVATE_KEY);
  const made = await repositoryToken(jwt, repository.fullName, repository.name, repository.push);
  if (!made)
    return refuse(
      404,
      `skel's GitHub App isn't installed on ${repository.fullName}: install it at ${installPage(env)}`,
    );
  return json(made);
}

// Renews someone's sign-in with its refresh token, which needs the app's client secret.
async function renewal(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.LIMIT.limit({ key: `ip:${ip}` })).success)
    return refuse(429, "too many requests: wait a minute");
  const given = await body(request);
  if (typeof given?.refresh_token !== "string") return refuse(400, "send a refresh_token");
  const renewed = await renew(env.CLIENT_ID, env.CLIENT_SECRET, given.refresh_token);
  return renewed ? json(renewed) : refuse(401, "GitHub refused the sign-in: sign in again");
}

// Registers or removes a wake-up address for a repository. Only someone who can push there
// may do either: each event sends a request to every address, and on a public repository
// anyone who can read it could otherwise switch off someone else's wake-ups.
async function wake(request: Request, env: Env, add: boolean): Promise<Response> {
  const asked = await caller(request, env);
  if ("refused" in asked) return asked.refused;
  const { given, repository } = asked;
  const url = wakeAddress(given.url);
  if (!url) return refuse(400, "a wake-up address must be an https URL");
  if (!repository.push)
    return refuse(403, `you can't push to ${repository.fullName}, so you can't set its wake-ups`);
  const before = await addresses(env, repository.fullName);
  const after = add ? [...new Set([...before, url])] : before.filter((known) => known !== url);
  if (after.length > mostAddresses)
    return refuse(400, `${repository.fullName} has ${mostAddresses} wake-up addresses already`);
  if (after.length === 0) await env.WAKE.delete(wakeKey(repository.fullName));
  else await env.WAKE.put(wakeKey(repository.fullName), JSON.stringify(after));
  return new Response(null, { status: 204 });
}

// Returns whether the body is signed with the app's webhook secret, as GitHub signs each event.
// WebCrypto's verify compares in constant time, so the signature can't be guessed byte by byte.
async function signedByGitHub(body: string, signature: string | null, secret: string) {
  const hex = signature?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const mac = Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(body));
}

// Passes one of the app's events on: checks its signature, reads only which repository it is
// for, and sends a bare request to each address registered for it. The rest of the event is
// dropped unread. GitHub only waits ten seconds, so the requests go out after the answer.
async function webhook(request: Request, env: Env, context: Context): Promise<Response> {
  const text = await request.text();
  if (!(await signedByGitHub(text, request.headers.get("x-hub-signature-256"), env.WEBHOOK_SECRET)))
    return refuse(401, "not signed by GitHub");
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return refuse(400, "not JSON");
  }
  const repository = isRecord(event) && isRecord(event.repository) ? event.repository : null;
  const fullName = repositoryName(repository?.full_name);
  if (!fullName) return new Response(null, { status: 204 });
  const urls = await addresses(env, fullName);
  // A Sprite that sleeps wakes for as long as the request is open, and an address that is
  // gone must not hold the rest up, so each gets a few seconds and its answer is ignored.
  context.waitUntil(
    Promise.allSettled(
      urls.map((url) => fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) })),
    ),
  );
  return new Response(null, { status: 204 });
}

// Returns the page that installs the app on repositories you pick.
const installPage = (env: Env) => `https://github.com/apps/${env.APP_SLUG}/installations/new`;

export default {
  // Answers one request. Errors are logged by their message alone, never with the request's
  // body, which can hold a token or an event's text.
  async fetch(request: Request, env: Env, context: Context): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    try {
      if (route === "GET /") return json({ install: installPage(env), client_id: env.CLIENT_ID });
      if (route === "POST /token") return await token(request, env);
      if (route === "POST /renew") return await renewal(request, env);
      if (route === "POST /wake") return await wake(request, env, true);
      if (route === "POST /unwake") return await wake(request, env, false);
      if (route === "POST /webhook") return await webhook(request, env, context);
      return refuse(404, "nothing here");
    } catch (error) {
      console.error(`${route} failed: ${error instanceof Error ? error.message : "unknown"}`);
      return refuse(502, "GitHub didn't answer as expected: try again");
    }
  },
};
