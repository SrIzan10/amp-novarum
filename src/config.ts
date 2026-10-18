const normalizeHandle = (item: string) => {
  const handle = item.trim().toLowerCase();
  return handle.startsWith('@') ? handle : `@${handle}`;
};

function list(value: string | undefined) {
  return (value ?? '').split(',').filter((item) => item.trim()).map(normalizeHandle);
}

function single(name: string) {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (value.includes(',')) throw new Error(`${name} takes exactly one handle`);
  return normalizeHandle(value);
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

export const config = {
  novarumUrl: (process.env.NOVARUM_URL ?? 'https://orwell.ing').replace(/\/+$/, ''),
  sessionToken: process.env.NOVARUM_SESSION_TOKEN,
  username: process.env.NOVARUM_USERNAME,
  password: process.env.NOVARUM_PASSWORD,

  // The one Novarum handle (@user:homeserver) allowed to drive Amp. Your API key pays for every
  // run, so this defaults to the account the bot is logged in as.
  ownerHandle: single('OWNER_HANDLE'),
  // Extra handles that trigger the bot besides its own (e.g. your own handle if you run it on a
  // separate account but also want "@you" to work).
  extraTriggerHandles: list(process.env.TRIGGER_HANDLES),

  ampApiKey: required('AMP_API_KEY'),
  // Run on a connected `amp --no-tui` runner (one of your machines) instead of an orb.
  ampRunnerId: process.env.AMP_RUNNER_ID || undefined,
  // Absolute directory served by the runner for new threads (empty = the runner's starting directory).
  ampRunnerDir: process.env.AMP_RUNNER_DIR || undefined,
  ampProject: process.env.AMP_PROJECT || undefined,
  // Agent mode: Claude Code by default; low | medium | high | ultra for Amp's own agent.
  ampMode: process.env.AMP_MODE || 'external-agent:claude-code',
  // Defaults for the model and effort, which the owner can change from chat. The model only applies
  // to external agents (Claude Code); Amp's own modes pick their model themselves.
  ampModel: process.env.AMP_MODEL || undefined,
  ampEffort: process.env.AMP_EFFORT || undefined,
  ampVisibility: (process.env.AMP_VISIBILITY || undefined) as
    | 'private'
    | 'unlisted'
    | 'workspace'
    | 'group'
    | undefined,
  ampUrl: (process.env.AMP_URL ?? 'https://ampcode.com').replace(/\/+$/, ''),

  contextMessages: Number(process.env.CONTEXT_MESSAGES ?? 20),
  dataDir: process.env.DATA_DIR ?? '.data',
};
