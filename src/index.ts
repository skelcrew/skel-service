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
    list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
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
// A name may hold two dots in a row, such as app..test, but may not be . or .. itself.
const repositoryName = (value: unknown) =>
  typeof value === "string" &&
  /^[\w.-]+\/[\w.-]+$/.test(value) &&
  value.split("/").every((part) => part !== "." && part !== "..")
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

// Where a repository's wake-up addresses are kept: one key each, under the repository's name
// as GitHub writes it, since that is how its events name it. A name can't hold a colon, so
// one repository's keys never start another's.
const wakePrefix = (fullName: string) => `wake:${fullName}:`;

// Returns the key one address is kept under. Each address has a key of its own, so two
// machines registering at once never write over each other. The address is hashed to keep
// the key short and free of the characters a URL may hold.
async function wakeKey(fullName: string, url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  // Buffer would need Node's compatibility on Workers, so the hex is spelled out.
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
  return wakePrefix(fullName) + hex.join("");
}

// Returns the keys of the addresses registered for a repository.
async function wakeKeys(env: Env, fullName: string): Promise<string[]> {
  const listed = await env.WAKE.list({ prefix: wakePrefix(fullName) });
  return listed.keys.map((key) => key.name);
}

// Returns the addresses registered for a repository. KV's listing can lag behind a removal,
// so a key whose address is already gone is skipped.
async function addresses(env: Env, fullName: string): Promise<string[]> {
  const keys = await wakeKeys(env, fullName);
  const urls = await Promise.all(keys.map((key) => env.WAKE.get(key)));
  return urls.filter((url) => url !== null);
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
      `Skelcrew's GitHub App isn't installed on ${repository.fullName}: install it at ${installPage(env)}`,
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
  const key = await wakeKey(repository.fullName, url);
  if (!add) {
    await env.WAKE.delete(key);
    return new Response(null, { status: 204 });
  }
  // KV takes one write to a key a second, and a machine may register twice in a row. An
  // address already kept is left alone, so registering it again never fails.
  if ((await env.WAKE.get(key)) !== null) return new Response(null, { status: 204 });
  // Machines registering at once may each see room for one more, so the limit can be passed
  // by a few. It only keeps the requests on each event bounded, so that is fine.
  const known = await wakeKeys(env, repository.fullName);
  if (known.length >= mostAddresses)
    return refuse(400, `${repository.fullName} has ${mostAddresses} wake-up addresses already`);
  await env.WAKE.put(key, url);
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
// for, and wakes each address registered for it. The rest of the event is dropped unread.
// GitHub only waits ten seconds, so the requests go out after the answer.
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
  context.waitUntil(wakeAll(await addresses(env, fullName)));
  return new Response(null, { status: 204 });
}

// Sends a bare request to each address, six at a time. A Worker keeps at most six requests
// open and queues the rest, and a Sprite that sleeps holds its request open while it wakes.
// Sent all at once, a queued request could spend its few seconds waiting for a slot. Each
// gets 5 seconds from when it starts, so 20 addresses take at most 20 of the 30 seconds a
// Worker may run after its answer.
async function wakeAll(urls: string[]): Promise<void> {
  for (let start = 0; start < urls.length; start += 6) {
    await Promise.allSettled(
      urls.slice(start, start + 6).map(async (url) => {
        const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) });
        // The answer is ignored, but its body must be let go to free the slot.
        await response.body?.cancel();
      }),
    );
  }
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
      if (route === "GET /github")
        return json({ install: installPage(env), client_id: env.CLIENT_ID });
      if (route === "POST /github/token") return await token(request, env);
      if (route === "POST /github/renew") return await renewal(request, env);
      if (route === "POST /github/wake") return await wake(request, env, true);
      if (route === "POST /github/unwake") return await wake(request, env, false);
      if (route === "POST /github/webhook") return await webhook(request, env, context);
      return refuse(404, "nothing here");
    } catch (error) {
      console.error(`${route} failed: ${error instanceof Error ? error.message : "unknown"}`);
      return refuse(502, "GitHub didn't answer as expected: try again");
    }
  },
};
