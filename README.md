# novarum-amp

A Novarum userbot that works like Amp's Slack integration: ping it in a channel or DM and it
runs an Amp agent in an **orb** (Amp's remote sandbox) with your API key, then replies with
the result.

## How it works

- Logs in to Novarum (`orwell.ing`) as a normal user account and listens on the `/realtime/`
  WebSocket for `message.created` events.
- **Mention** the account (`@amp:orwell.ing do X`), or DM it, to start a new Amp thread. The last
  `CONTEXT_MESSAGES` messages in the channel go to Amp as context, along with signed attachment URLs.
- **Reply** to any of the bot's messages (or mention it again in a reply) to continue the same
  Amp thread, the way Slack threads do.
- While Amp works, the bot shows a typing indicator and a status message that it edits as Amp
  runs tools. When the run ends, it deletes the status message and replies with the answer and an
  **Open in Amp** link.
- Reply `stop` or `cancel` to a thread's message to abort the running turn.
- Only handles in `ALLOWED_HANDLES` can trigger it. If that's empty, only the bot's own account can.

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
messages it sent itself, and DMs you send to other people don't trigger it. It reports itself as a
backgrounded client, so your other devices keep getting push notifications.

State (session token, Novarum message → Amp thread map) lives in `.data/`.
