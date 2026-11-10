# skel-service

Skelcrew's GitHub App is shared by everyone who uses Skelcrew. Its secrets can't ship inside
Skelcrew, where anyone could read them. So this small service holds them, and does only what
needs them:

- it makes GitHub tokens, each for one repository, for one hour;
- it renews your sign-in to the app, which needs the app's client secret;
- it passes GitHub's events on as wake-ups, so a Sprite that sleeps wakes when you comment on
  or merge a PR.

It is one Cloudflare Worker with no database and no dependencies. Skelcrew's GitHub plugin,
[skel-plugin-github](https://github.com/skelcrew/skel-plugin-github), is its only client.
Skelcrew itself never needs it: with no plugins, Skelcrew runs on git alone.

## What the service sees

- **Who asks for a token, for which repository.** Each request carries your sign-in. The
  service asks GitHub who you are and whether you can reach the repository, then asks GitHub
  for a token. It keeps nothing of either.
- **Your refresh token, while it renews your sign-in.** It passes it to GitHub with the app's
  secret and hands the new sign-in back. It keeps neither.
- **Which repository each of the app's events is for.** It checks the event's signature, reads
  `repository.full_name`, and drops the rest unread.
- **Each machine's wake-up address.** This is its only lasting record, kept in Workers KV:
  each address under a key of its own, `wake:<owner/name>:<SHA-256 of the address>`, so two
  machines registering at once never undo each other. An address gets a bare `POST` with no
  body, which only says "look now".

Code and issues never pass through it. git and the GitHub plugin talk to GitHub directly, with
the token the service made. It logs no request bodies: an error is logged by its message
alone. One person may ask 30 times a minute.

A token works for one repository and lasts an hour. Someone who can push to the repository
gets a token with all of the app's permissions there. Anyone else gets one that only reads, so
the app's access never reaches past yours. Only someone who can push registers or removes a
wake-up address for a repository.

While the service is down, a token can't be renewed. Within the hour Skelcrew can't read, push
or post on GitHub, and threads wait. Nothing is lost: once it is back, Skelcrew's next poll
catches up.

## Calls

Every call is under `/github`, so a service for another tool can sit beside it later. All
answers are JSON. A refusal is `{ "error": "<what to fix>" }` with an HTTP status.

| Request | Body | Answer |
| --- | --- | --- |
| `GET /github` | | `{ install, client_id }`: the page that installs the app, and the client ID the plugin's device flow signs in with |
| `GET /github/installed` | | A page that says the app is installed and to go back to your terminal. Set it as the app's Setup URL |
| `POST /github/token` | `{ repository }`, as `owner/name`, with your sign-in as `Authorization: Bearer` | `{ token, expires }` |
| `POST /github/renew` | `{ refresh_token }` | `{ access_token, expires_in, refresh_token, refresh_token_expires_in }` |
| `POST /github/wake` | `{ repository, url }`, with your sign-in | Nothing (204). Registers the address |
| `POST /github/unwake` | `{ repository, url }`, with your sign-in | Nothing (204). Removes it |
| `POST /github/webhook` | One of the app's events, from GitHub | Nothing (204). Wakes each address registered for its repository |

The plugin signs you in itself with GitHub's device flow, which needs only the client ID.

## The app

The app asks GitHub for:

| Permission | Access | For |
| --- | --- | --- |
| Contents | Read and write | Pushing a thread's branch |
| Pull requests | Read and write | Opening PRs and posting reviews |
| Issues | Read and write | Tasks, the `skelcrew` label and the 👀 reaction |
| Commit statuses | Read and write | The `skelcrew/check` status check |
| Checks | Read | A failed check |
| Actions | Read | A failed check's log |
| Metadata | Read | Always needed |

It has no permission for workflows, so it can't push a change to `.github/workflows`.

Its events are issues, issue comments, PRs, PR reviews, PR review comments, check runs, check
suites and statuses. They are used only for wake-ups.

## Deploying

You need a Cloudflare account and the app's secrets. Deploying uses Cloudflare's `wrangler`,
run with `bunx`, so nothing is added to this repository.

1. **Register the app.** If it already exists, update it as
   [Updating an existing app](#updating-an-existing-app) says instead. To register it, open
   `register.html` in your browser. Change the organization in its form's address if the app
   isn't for `skelcrew`, and press the button. GitHub shows the app, and the button that
   creates it. It then sends you to `https://skelcrew.dev/github?code=…`: copy the code from the
   address. Within an hour, run:

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

   If the app's slug isn't `skelcrew`, set `APP_SLUG` in `wrangler.toml` to it.
5. **Deploy.** The route in `wrangler.toml` sends `skelcrew.dev/github` to the Worker, so the
   domain must be a zone in your Cloudflare account:

   ```sh
   bunx wrangler deploy
   ```

6. **Check it**: `curl https://skelcrew.dev/github` answers the install page and client ID.

## Updating an existing app

Skelcrew's app, `skelcrew`, existed before this service. Rather than register it again, make
its settings on GitHub match the manifest in `register.html`, then make its secrets:

1. **Permissions and events.** Under Permissions & events, give it the permissions in the
   table above, and subscribe it to the events listed under the table. Each installation
   accepts the new permissions before they apply there.
2. **Webhook.** Under General, set the homepage URL to `https://skelcrew.dev`, tick Webhook
   Active, and set the webhook URL to `https://skelcrew.dev/github/webhook`.
3. **Device flow.** Under General, tick "Enable Device Flow", and leave "Expire user
   authorization tokens" ticked. Under "Post installation", set the Setup URL to
   `https://skelcrew.dev/github/installed` and tick "Redirect on update".
4. **Public.** Under Advanced, make it public, so anyone can install it.
5. **A webhook secret.** Make one, such as with `openssl rand -hex 32`. Put it in the Webhook
   secret field under General, and set it with `bunx wrangler secret put WEBHOOK_SECRET`.
6. **A new private key.** Under Private keys, generate one, and set it with
   `bunx wrangler secret put PRIVATE_KEY < skelcrew.<date>.private-key.pem`.
7. **The rest.** Under General, generate a client secret. Set `APP_ID` (the App ID, 5524475),
   `CLIENT_ID` and `CLIENT_SECRET` with `bunx wrangler secret put`.

Then deploy from step 3 of Deploying, and skip step 4, whose secrets are now set.

## Running your own

To depend on no one, run the service yourself, with a GitHub App of your own. Follow the steps
above with your own names: in `register.html`, give the app a name of its own and your own
service's address in `url`, `redirect_url` and `hook_attributes.url`, and post it to your
organization or to `https://github.com/settings/apps/new` for your own account. In
`wrangler.toml`, change the route and its zone to your own domain. Then, in the
GitHub plugin's setup, give your service's address in place of `https://skelcrew.dev`. It is
the same plugin, the same setup, and one way through the code.

## Rotating the key

1. In the app's settings on GitHub, under Private keys, generate a new key. GitHub downloads
   it as a `.pem` file.
2. Set it: `bunx wrangler secret put PRIVATE_KEY < skelcrew.<date>.private-key.pem`. Workers pick
   up a secret at once.
3. Check that Skelcrew still reads GitHub, such as with `sc task ls` on a machine with the
   plugin. Then delete the old key on GitHub, and the `.pem` file.

The client secret and the webhook secret rotate the same way: make a new one on GitHub, set it
with `wrangler secret put`, then remove the old one. A webhook secret changed on GitHub before
the Worker drops events until both match, and Skelcrew's polling covers them meanwhile.

The key may be in either form, the PKCS#1 GitHub gives (`BEGIN RSA PRIVATE KEY`) or PKCS#8.

## Working on it

```sh
bun install
bun run check    # format, lint, typecheck and tests
```

The tests run the Worker's fetch handler with GitHub faked and a Map in place of KV, listed
by prefix as KV lists.
