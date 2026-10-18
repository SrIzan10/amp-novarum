function list(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith('@') ? item : `@${item}`));
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

  // Novarum handles (@user:homeserver) allowed to drive Amp. Your API key pays for every run,
  // so this defaults to only the account the bot is logged in as.
  allowedHandles: list(process.env.ALLOWED_HANDLES),
  // Extra handles that trigger the bot besides its own (e.g. your own handle if you run it on a
  // separate account but also want "@you" to work).
  extraTriggerHandles: list(process.env.TRIGGER_HANDLES),

  ampApiKey: required('AMP_API_KEY'),
  ampProject: process.env.AMP_PROJECT || undefined,
  ampMode: process.env.AMP_MODE || undefined,
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
