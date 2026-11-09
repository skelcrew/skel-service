# skel-service

skel's GitHub App is shared by everyone who uses skel. Its secrets can't ship inside skel,
where anyone could read them. So this small service holds them, and does only what needs them:

- it makes GitHub tokens, each for one repository, for one hour;
- it renews your sign-in to the app, which needs the app's client secret;
- it passes GitHub's events on as wake-ups, so a Sprite that sleeps wakes when you comment on
  or merge a PR.

It is one Cloudflare Worker with no database and no dependencies. skel's GitHub plugin,
[skel-plugin-github](https://github.com/skelcrew/skel-plugin-github), is its only client. skel
itself never needs it: with no plugins, skel runs on git alone.

## What the service sees

- **Who asks for a token, for which repository.** Each request carries your sign-in. The
  service asks GitHub who you are and whether you can reach the repository, then asks GitHub
  for a token. It keeps nothing of either.
- **Your refresh token, while it renews your sign-in.** It passes it to GitHub with the app's
  secret and hands the new sign-in back. It keeps neither.
- **Which repository each of the app's events is for.** It checks the event's signature, reads
  `repository.full_name`, and drops the rest unread.
- **Each machine's wake-up address.** This is its only lasting record, kept in Workers KV:
  for each repository, the addresses registered for it. An address gets a bare `POST` with no
  body, which only says "look now".

Code and issues never pass through it. git and the GitHub plugin talk to GitHub directly, with
the token the service made. It logs no request bodies: an error is logged by its message
alone. One person may ask 30 times a minute.

A token works for one repository and lasts an hour. Someone who can push to the repository
gets a token with all of the app's permissions there. Anyone else gets one that only reads, so
the app's access never reaches past yours. Only someone who can push registers a wake-up
address for a repository.

While the service is down, a token can't be renewed. Within the hour skel can't read, push or
post on GitHub, and threads wait. Nothing is lost: once it is back, skel's next poll catches up.

## Calls

All answers are JSON. A refusal is `{ "error": "<what to fix>" }` with an HTTP status.

| Request | Body | Answer |
| --- | --- | --- |
| `GET /` | | `{ install, client_id }`: the page that installs the app, and the client ID the plugin's device flow signs in with |
| `POST /token` | `{ repository }`, as `owner/name`, with your sign-in as `Authorization: Bearer` | `{ token, expires }` |
| `POST /renew` | `{ refresh_token }` | `{ access_token, expires_in, refresh_token, refresh_token_expires_in }` |
| `POST /wake` | `{ repository, url }`, with your sign-in | Nothing (204). Registers the address |
| `POST /unwake` | `{ repository, url }`, with your sign-in | Nothing (204). Removes it |
| `POST /webhook` | One of the app's events, from GitHub | Nothing (204). Wakes each address registered for its repository |

The plugin signs you in itself with GitHub's device flow, which needs only the client ID.

## The app

The app asks GitHub for:

| Permission | Access | For |
| --- | --- | --- |
| Contents | Read and write | Pushing a thread's branch |
| Pull requests | Read and write | Opening PRs and posting reviews |
| Issues | Read and write | Tasks, the `skel` label and the 👀 reaction |
| Commit statuses | Read and write | The `skel/review` check |
| Checks | Read | A failed check |
| Actions | Read | A failed check's log |
| Metadata | Read | Always needed |

It has no permission for workflows, so it can't push a change to `.github/workflows`.

Its events are issues, issue comments, PRs, PR reviews, PR review comments, check runs, check
suites and statuses. They are used only for wake-ups.

## Deploying

You need a Cloudflare account and the app's secrets. Deploying uses Cloudflare's `wrangler`,
run with `bunx`, so nothing is added to this repository.

1. **Register the app.** Open `register.html` in your browser. Change the organization in its
   form's address if the app isn't for `skelcrew`, and press the button. GitHub shows the app,
   and the button that creates it. It then sends you to `https://skel.run/?code=…`: copy the
   code from the address. Within an hour, run:

   ```sh
   gh api -X POST /app-manifests/<code>/conversions > app.json
   ```

   `app.json` holds the app's ID, slug, client ID, client secret, webhook secret and private key.
   Keep it out of any repository, and delete it once the secrets are set.
2. **Turn on the device flow.** In the app's settings on GitHub, under General, tick
   "Enable Device Flow". A manifest can't turn it on. Leave "Expire user authorization tokens"
   ticked.
3. **Create the store of addresses**, and put its ID in `wrangler.toml`:

   ```sh
   bunx wrangler kv namespace create WAKE
   ```

4. **Set the secrets**, from `app.json`:

   ```sh
   jq -r .id app.json | bunx wrangler secret put APP_ID
   jq -r .pem app.json | bunx wrangler secret put PRIVATE_KEY
   jq -r .client_id app.json | bunx wrangler secret put CLIENT_ID
   jq -r .client_secret app.json | bunx wrangler secret put CLIENT_SECRET
   jq -r .webhook_secret app.json | bunx wrangler secret put WEBHOOK_SECRET
   ```

   If the app's slug isn't `skel`, set `APP_SLUG` in `wrangler.toml` to it.
5. **Deploy**, then point the domain at the Worker in Cloudflare's dashboard, under the
   Worker's Domains and Routes:

   ```sh
   bunx wrangler deploy
   ```

6. **Check it**: `curl https://skel.run/` answers the install page and client ID.

## Running your own

To depend on no one, run the service yourself, with a GitHub App of your own. Follow the steps
above with your own names: in `register.html`, give the app a name of its own and your own
service's address in `url`, `redirect_url` and `hook_attributes.url`, and post it to your
organization or to `https://github.com/settings/apps/new` for your own account. Then, in the
GitHub plugin's setup, give your service's address in place of `https://skel.run`. It is the
same plugin, the same setup, and one way through the code.

## Rotating the key

1. In the app's settings on GitHub, under Private keys, generate a new key. GitHub downloads
   it as a `.pem` file.
2. Set it: `bunx wrangler secret put PRIVATE_KEY < skel.<date>.private-key.pem`. Workers pick
   up a secret at once.
3. Check that skel still reads GitHub, such as with `skel task ls` on a machine with the
   plugin. Then delete the old key on GitHub, and the `.pem` file.

The client secret and the webhook secret rotate the same way: make a new one on GitHub, set it
with `wrangler secret put`, then remove the old one. A webhook secret changed on GitHub before
the Worker drops events until both match, and skel's polling covers them meanwhile.

The key may be in either form, the PKCS#1 GitHub gives (`BEGIN RSA PRIVATE KEY`) or PKCS#8.

## Working on it

```sh
bun install
bun run check    # format, lint, typecheck and tests
```

The tests run the Worker's fetch handler with GitHub faked and a Map in place of KV.
