# novarum-amp

A Novarum userbot that works like Amp's Slack integration: ping it in a server channel and it
runs an Amp agent in an **orb** (Amp's remote sandbox) with your API key, then replies with
the result.

## How it works

- Logs in to Novarum (`orwell.ing`) as a normal user account and listens on the `/realtime/`
  WebSocket for `message.created` events.
- **Mention** the account (`@amp:orwell.ing do X`) in a server channel to start a new Amp thread.
  DMs are ignored completely. The last `CONTEXT_MESSAGES` messages in the channel go to Amp as
  context, along with signed attachment URLs.
- Novarum has replies instead of threads, so a **reply chain** stands in for a Slack thread. When
  you mention the bot inside a reply chain, Amp also gets the messages in that chain.
- **Reply** to any of the bot's messages, or mention it anywhere further down the same reply chain,
  to continue that Amp thread, just as re-mentioning @Amp in a Slack thread does. Amp also gets the
  messages other people posted since its last reply.
- Like Slack's byline, every answer ends with whose Amp replied and an **Open in Amp** link.
- While Amp works, the bot shows a typing indicator and a status message that it edits as Amp
  runs tools. When the run ends, it deletes the status message and replies with the answer.
- Reply `stop` or `cancel` to a thread's message to abort the running turn.
- **Model and effort:** `@bot model opus` and `@bot effort high` change the defaults (kept in
  `settings.json` in the data dir). `@bot model` or `@bot effort` alone shows the current value, and
  `reset` goes back to `AMP_MODEL` / `AMP_EFFORT`. For a single run, put flags before the request:
  `@bot --model sonnet --effort low fix the typo` (`-m` and `-e` work too). The model only applies to
  external agents like Claude Code.
- Only `OWNER_HANDLE` can trigger it. If that's empty, only the bot's own account can.

By default the agent is **Claude Code** (`AMP_MODE=external-agent:claude-code`). To run on one of
your own machines instead of an orb, set `AMP_RUNNER_ID` to an `amp --no-tui` runner and
`AMP_RUNNER_DIR` to the directory it serves (for example `/home/you/amp/novarum`). A directory on a
runner is not an Amp project, so `AMP_PROJECT` only applies to orbs.

The Amp v2 External API (`ampcode.com/api/v2`) only offers workspace admin and read access, so it
can't run agents. This bot uses the Amp SDK (`@ampcode/sdk`) with `executor: 'orb'`, which drives
the bundled Amp CLI.

## Setup

```bash
bun install
cp .env.example .env   # fill in AMP_API_KEY and Novarum credentials
bun start
```

### Docker

```bash
cp .env.example .env              # fill it in
docker compose run --rm novarum-amp   # first run only if you need to type an MFA code
docker compose up -d --build
```

The session and thread map persist in the `data` volume, mounted at `/data`.

### Running it on your own account

If you log in as yourself, the bot answers when you ping your own handle. It never reacts to
messages it sent itself, and it ignores DMs entirely. It reports itself as a
backgrounded client, so your other devices keep getting push notifications.

State (session token, Novarum message → Amp thread map) lives in `.data/`.
