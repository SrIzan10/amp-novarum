# novarum-amp

A Novarum bot, built on [`@novarum/sdk`](https://www.npmjs.com/package/@novarum/sdk), that works like Amp's Slack integration: ping it in a server channel and it
runs an Amp agent in an **orb** (Amp's remote sandbox) with your API key, then replies with
the result.

## How it works

- Connects to Novarum (`orwell.ing`) as a bot with a token from the developer panel, and listens
  for new messages and interactions through the SDK.
- **Mention** the account (`@amp:orwell.ing do X`) in a server channel to start a new Amp thread.
  DMs are ignored completely. The last `CONTEXT_MESSAGES` messages in the channel go to Amp as
  context, along with signed attachment URLs.
- Novarum has replies instead of threads, so a **reply chain** stands in for a Slack thread. When
  you mention the bot inside a reply chain, Amp also gets the messages in that chain.
- **Reply** to any of the bot's messages, or mention it anywhere further down the same reply chain,
  to continue that Amp thread, just as re-mentioning @Amp in a Slack thread does. Amp also gets the
  messages other people posted since its last reply.
- Like Slack's byline, every answer ends with whose Amp replied, with an **Open in Amp** link button.
- While Amp works, the bot shows a typing indicator and a status message that it edits as Amp
  runs tools, with a **Stop** button. When the run ends, it deletes the status message and replies
  with the answer. A failed run is reported in a red embed.
- **Attachments:** reply to a message with an image (or any file) and mention the bot, and that file
  is uploaded to the Amp thread as an attachment on your request, along with any files on your own
  message. This uses the CLI's `--attach`, which the SDK doesn't expose yet, so
  `patches/@ampcode%2Fsdk@*.patch` adds an `attach` option to `execute`.
- Press **Stop** on the status message, or reply `stop` / `cancel` to a thread's message, to abort the
  running turn.
- **Model and effort:** the `/model` and `/effort` slash commands change the defaults (kept in
  `settings.json` in the data dir). With no argument they show the current value, and `reset` goes
  back to `AMP_MODEL` / `AMP_EFFORT`. `/model` autocompletes aliases; `@bot model opus` in chat still works. For a single run, put flags before the request:
  `@bot --model sonnet --effort low fix the typo` (`-m` and `-e` work too). The model only applies to
  external agents like Claude Code.
- Only `OWNER_HANDLE` can trigger it, use the slash commands, or press Stop. It's required.

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
cp .env.example .env   # fill in AMP_API_KEY, NOVARUM_BOT_TOKEN and OWNER_HANDLE
bun start
```

### Docker

```bash
cp .env.example .env              # fill it in
docker compose up -d --build
```

The thread map and settings persist in the `data` volume, mounted at `/data`.

State (Novarum message → Amp thread map, model/effort settings) lives in `.data/`.
