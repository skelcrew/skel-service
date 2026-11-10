// What skel's service asks of GitHub: who a sign-in belongs to, what it can reach, and a token
// for one repository, made as skel's GitHub App with its private key.

// Identifies the service to GitHub, which refuses API requests without a user agent.
const headers = { "user-agent": "skel-service", accept: "application/vnd.github+json" };

// Returns bytes as base64url, the encoding a JWT is written in.
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

// Returns a DER length: one byte below 128, else a byte saying how many bytes follow.
function derLength(length: number): number[] {
  if (length < 128) return [length];
  const bytes: number[] = [];
  for (let left = length; left > 0; left >>= 8) bytes.unshift(left & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// Returns the private key's PEM as the PKCS#8 bytes WebCrypto imports. GitHub hands out an
// app's key as PKCS#1 ("BEGIN RSA PRIVATE KEY"), which WebCrypto can't read, so that form is
// wrapped in PKCS#8's few fixed bytes here rather than asking you to convert it first.
function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), (c) =>
    c.charCodeAt(0),
  );
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return der;
  const version = [0x02, 0x01, 0x00];
  // The algorithm: rsaEncryption, with no parameters.
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  const key = [0x04, ...derLength(der.length), ...der];
  const inner = [...version, ...algorithm, 0x05, 0x00, ...key];
  return Uint8Array.from([0x30, ...derLength(inner.length), ...inner]);
}

// Returns a JWT that proves to GitHub that the caller is the app, signed RS256 with the app's
// private key. It is backdated a minute, as GitHub refuses one from a clock ahead of its own,
// and lasts nine, under GitHub's limit of ten.
export async function appJwt(appId: string, privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const text = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${text({ alg: "RS256", typ: "JWT" })}.${text({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

// Returns GitHub's JSON answer to a GET, with the token as bearer, or null when GitHub
// refuses the token or finds nothing there, so the caller says what that means. Any other
// failure, such as a rate limit or an outage, throws: told to sign in again for it, you
// would throw away a sign-in that still works, so the service asks you to try again.
async function get(path: string, token: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { ...headers, authorization: `Bearer ${token}` },
  });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${path} with ${response.status}`);
  return response.json();
}

// Returns who a GitHub sign-in belongs to, or null when GitHub doesn't accept it, so the
// service knows whom a token is for and whose requests to count.
export async function signedIn(userToken: string): Promise<{ id: number } | null> {
  const user = await get("/user", userToken);
  return isRecord(user) && typeof user.id === "number" ? { id: user.id } : null;
}

// Returns the repository as the signed-in person sees it: its name as GitHub writes it, and
// whether they can push to it. Null when they can't reach it, whether it doesn't exist, is
// private to others, or the app's sign-in may not see it.
export async function reach(
  userToken: string,
  repository: string,
): Promise<{ fullName: string; name: string; push: boolean } | null> {
  const repo = await get(`/repos/${repository}`, userToken);
  if (!isRecord(repo) || typeof repo.full_name !== "string" || typeof repo.name !== "string")
    return null;
  const push = isRecord(repo.permissions) && repo.permissions.push === true;
  return { fullName: repo.full_name, name: repo.name, push };
}

// What a token for someone who can't push may do: read what the GitHub plugin reads, and
// nothing more, so the app's write access never reaches past yours.
const reading = {
  metadata: "read",
  contents: "read",
  issues: "read",
  pull_requests: "read",
  statuses: "read",
  checks: "read",
  actions: "read",
};

// Returns a token from the app for one repository, which GitHub ends after an hour, with when
// it ends. It can write only when `write`. Null when the app isn't installed there.
export async function repositoryToken(
  jwt: string,
  fullName: string,
  name: string,
  write: boolean,
): Promise<{ token: string; expires: string } | null> {
  const installation = await get(`/repos/${fullName}/installation`, jwt);
  if (!isRecord(installation) || typeof installation.id !== "number") return null;
  const response = await fetch(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ repositories: [name], ...(write ? {} : { permissions: reading }) }),
    },
  );
  if (!response.ok) throw new Error(`GitHub made no token: ${response.status}`);
  const made = await response.json();
  if (!isRecord(made) || typeof made.token !== "string" || typeof made.expires_at !== "string")
    throw new Error("GitHub's token wasn't what the service expects");
  return { token: made.token, expires: made.expires_at };
}

// What renewing a sign-in gives back: the new sign-in and when each part of it runs out.
export type Renewed = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
};

// Renews a person's sign-in to the app with its refresh token, which only works with the
// app's client secret. Returns the new sign-in, or null when GitHub refuses the refresh token,
// such as one already spent. GitHub says so with a 200 and an error field.
export async function renew(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<Renewed | null> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { ...headers, accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  // A refused refresh token comes back as a 200, so a failure here is GitHub's own, and
  // throws for the same reason a failed GET does.
  if (!response.ok) throw new Error(`GitHub renewed no sign-in: ${response.status}`);
  const got = await response.json();
  if (
    !isRecord(got) ||
    typeof got.access_token !== "string" ||
    typeof got.expires_in !== "number" ||
    typeof got.refresh_token !== "string" ||
    typeof got.refresh_token_expires_in !== "number"
  )
    return null;
  const { access_token, expires_in, refresh_token, refresh_token_expires_in } = got;
  return { access_token, expires_in, refresh_token, refresh_token_expires_in };
}

// Returns whether a value is a JSON object, so its fields can be checked one by one.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
