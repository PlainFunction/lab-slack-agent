# Lab 004: an AI assistant that lives in Slack

The code behind our lab [An AI Assistant That Lives in Slack](https://plainfunction.com.au/labs/slack-agent). Slack is the
whole interface: you talk to it in a DM or a thread, and anything that changes
something shows up as a Slack form with every argument filled in and editable.
Nothing runs until someone allowed says yes.

The agent itself is our `slack-agent` capability. This lab is a Worker that
uses it: a config file, and the tools it has.

```ts
// src/worker.ts
export default createSlackAgent({ tools })

// src/tools.ts
export const tools = ({ env, cipher, timeZone }: ToolsContext) => [
  timeTools(timeZone),
  noteTools(env.KV, cipher),
]
```

```bash
npm install
npm test          # checks the capabilities copy, then this Worker's tests
npm run typecheck
npm run dev       # wrangler dev, with GLM 4.7 Flash on Workers AI
```

## What it uses from capabilities

`capabilities/` holds copies of the parts of our capabilities it uses, so it
runs on its own. `capabilities/index.ts` says which parts, and the copies are kept in step
with ours automatically. **Don't
edit the copies**: they're overwritten from the source on every sync.

The agent is `capabilities/core/slack-agent`: the loop, the tool contract,
forms, approvals, follow-up questions, settings in Slack, the credential
broker, the queue and the Worker. Its `README.spec.md` has every port and
adapter. Its own tests (over a hundred, in workerd with real D1, KV and
crypto) stay with the source, so they aren't in this copy. Connecting accounts by OAuth is
core's `integrations` (`ConnectedAccounts`, `D1TokenVault`).

Underneath it uses the same pieces as client work: secrets that print as
`[secret]`, AES-GCM sealing bound to each record's id, signed button refs, an
egress allowlist, redaction before the model, spend metering, a hash-chained
audit log and tracing on every port.

## How it runs

```
Slack ──signed──▶ Worker ──sealed job──▶ Queue ──▶ Agent loop ──▶ Slack
                  (checks, routes,                 (model, tools,
                   answers in < 3 s)                forms, ledger)
```

- **One Worker per workspace**, like one Worker per client: its own D1, KV,
  queue and secrets. No tenant ids, so no tenant mix-ups.
- **The consumer runs one job at a time** (`max_concurrency = 1`), which keeps
  two messages in one thread from overwriting each other, and means a rotating
  refresh token is never spent twice at once.
- **The model answers in JSON**: a reply or one tool call, checked against a
  schema. It's GLM 4.7 Flash with thinking off; `AI_MODEL` picks another, and
  `"offline"` is a free stand-in that picks tools by keyword.

## Adding tools

A tool server is a `LocalToolServer` of `tool()` definitions. Inputs are
`ui.*` fields and outputs are `out.*` fields, so the agent can draw them as
Slack forms. It refuses to start if a field has no hint.

```ts
import { LocalToolServer, out, tool, ui } from '#capabilities'
import { z } from 'zod'

export const greetTools = new LocalToolServer('greet', {
  hello: tool({
    description: 'Says hello to someone',
    input: z.object({ who: ui.user('Who') }),
    output: z.object({ said: out.text('Said') }),
    annotations: { readOnlyHint: true },
    run: ({ who }) => ({ said: `Hello <@${who}>` }),
  }),
}, { use: 'Saying hello', personalInfo: [], storesIn: 'Nowhere' })
```

Then either:

- **add it to `src/tools.ts`**, so it runs inside this Worker, or
- **deploy it as its own Worker** (`export default { fetch: serveMcp(greetTools) }`),
  bind that Worker to this one as a service, and list the binding in
  `MCP_BINDINGS`. A tool lab can be just that.

**Images and links.** `ui.image('Photo')` takes an image someone attached in
the conversation (the form shows a pick of them) and the tool reads it with
`ctx.file(id)`. `out.image` shows an https image, or uploads one the tool
made as a `data:image/png;base64,...` URL. `out.link` shows a link. The
main model never sees an image, only that one was attached or shown.
`images__describe` (from `imageTools`) sends one to a cheap vision model when
someone asks about it, and the main model reads the description.

```ts
resize: tool({
  description: 'Makes a smaller copy of a photo',
  input: z.object({ photo: ui.image('Photo') }),
  output: z.object({ copy: out.image('Smaller copy') }),
  annotations: { readOnlyHint: true },
  run: async ({ photo }, ctx) => {
    const f = await ctx.file(photo)   // { name, mimetype, bytes }
    return { copy: `data:image/png;base64,${toBase64(await shrink(f.bytes))}` }
  },
}),
```

A tool that isn't read-only asks first, unless `TOOL_POLICY` or an admin in
Slack says otherwise. A tool calls out only with `ctx.fetch(url, { credential })`,
and can stop to ask a question with `ctx.elicit`, as `notes__forget` does.

## In Slack

- **Approvals.** A tool call that changes something is a form with Approve and
  Deny. Fix anything wrong in the form, then approve. A double click runs once.
- **Follow-up questions.** A tool can stop and ask, and runs again from the
  top with the answers. Nothing with a side effect may happen before its last
  question.
- **Settings.** An admin (`ADMIN_USERS`) says `settings` in a DM: pause, time
  zone, instructions, the monthly limit (up to `MAX_CAP_USD`), which tool
  servers are on, and allow, ask or never per tool. Only changes from config
  are stored.
- **Connecting accounts.** An admin says `connect github` and gets a link only
  they can see. The token is sealed in D1 and only ever used by the broker.
  `disconnect github` removes it.

## Setting it up

1. Create the Slack app from `slack-manifest.json` (api.slack.com/apps →
   Create New App → From a manifest), with `YOUR-HOST` swapped for your
   Worker's URL. Start the Worker first: Slack checks the events URL when it
   saves. Then install it to the workspace. The scopes are only what the code
   uses: posting and updating (`chat:write`), the 👀 while it works
   (`reactions:write`), reading attached images (`files:read`), sharing
   images tools made (`files:write`), and seeing DMs, mentions and threads
   it's in. Adding scopes to an installed app needs a reinstall. If you
   change `ASSISTANT_NAME`, change the two names in the manifest too. If a DM
   with the app says "Sending messages to this app has been turned off", check
   App Home → Messages Tab → "Allow users to send … messages", then reload
   Slack (Ctrl+R). The desktop app keeps showing the old notice until then.
   For connected accounts, also create an OAuth app with the callback
   `<PUBLIC_URL>/oauth/callback`.
2. `wrangler d1 create slack-agent --location oc`, `wrangler kv namespace create slack-agent`,
   `wrangler queues create slack-agent-jobs`, and put the ids in `wrangler.toml`.
3. Apply the schema (`capabilities/core/schema.sql`): `npm run db:local` for
   `wrangler dev`, `npm run db:remote` for the deployed one. Both are safe to
   run again. Run wrangler through these scripts or with `--config wrangler.toml`,
   so it uses this folder's config.
4. Secrets: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `KEYRING`, `SIGNING_KEY`
   (formats in `wrangler.toml`), plus `OAUTH_<NAME>_CLIENT_ID` and
   `OAUTH_<NAME>_CLIENT_SECRET` for each provider. `.dev.vars.example` lists
   them all with their formats. For `wrangler dev`, copy it to `.dev.vars`, or
   `npm run dev:secrets` writes `.dev.vars` with a new `KEYRING` and
   `SIGNING_KEY` and blank Slack lines to fill in. It never replaces a value
   that's there, because a new keyring can't open what the old one sealed.
   Keep a copy of the keyring somewhere safe.
5. Set `ALLOWED_USERS`, `ADMIN_USERS` and `SLACK_TEAM_ID` (the `T…` id, not
   the workspace's address). They're secrets, not vars, so whose workspace this
   is stays out of git: in `.dev.vars` for `wrangler dev`, and
   `wrangler secret put <NAME> --config wrangler.toml` for the deployed one.

## Tested, and not yet tested

The agent's own tests stay with our capabilities. This lab's tests check its
own part: that the Worker starts with this config, answers
Slack's URL check, refuses an unsigned request, and has these tools.

Checked in a real Slack workspace: signing, mentions and threads, DMs, a form
inside a message sending back a date someone picked, turning a tool off in
settings, and GLM 4.7 Flash replying and picking tools.

Not yet run against the real thing:
- the rest of it in Slack: approvals with edits, follow-up questions, settings
  pages, connecting an account, and images both ways (Slack's file download,
  which must not redirect, and the three-step upload). It follows Slack's docs and is tested against
  recorded shapes
- a real OAuth provider. GitHub's flow follows its docs, PKCE included
- the per-million-token prices in core's `slack-agent/agent/spend.ts`, apart
  from GLM 4.7 Flash, which is from its model page. Check them before relying
  on the cap

Not built, compared with the write-up: OpenRouter (it's Workers AI only for
now), and choosing a model in settings, which only matters once there's more
than one.

## About this repo

This repo is synced automatically from another source, so it's read-only: pull requests and pushes aren't accepted here. If you spot a problem, tell us through [plainfunction.com.au/contact](https://plainfunction.com.au/contact).

Fork it and do what you like with it under the licence below.
