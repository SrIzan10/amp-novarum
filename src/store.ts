import { config } from './config';

// Maps Novarum message IDs (the ping and the bot's replies) to the Amp thread they belong to,
// so replying to any of them continues the same Amp thread — like a Slack thread.
const file = Bun.file(`${config.dataDir}/threads.json`);
const threads: Record<string, string> = (await file.exists()) ? await file.json() : {};

let writing = Promise.resolve();

export function threadFor(messageId: string | null | undefined) {
  return messageId ? threads[messageId] : undefined;
}

export function linkThread(threadId: string, ...messageIds: string[]) {
  for (const id of messageIds) threads[id] = threadId;
  writing = writing.then(() => Bun.write(file, JSON.stringify(threads))).then(() => {});
}

// Model and effort picked from chat with `@bot model …` / `@bot effort …`, kept across restarts.
export interface AgentSettings {
  model?: string;
  effort?: string;
}

const settingsFile = Bun.file(`${config.dataDir}/settings.json`);
const settings: AgentSettings = (await settingsFile.exists()) ? await settingsFile.json() : {};

export const agentSettings = () => ({ ...settings });

export function setAgentSetting(key: keyof AgentSettings, value: string | undefined) {
  if (value) settings[key] = value;
  else delete settings[key];
  writing = writing.then(() => Bun.write(settingsFile, JSON.stringify(settings))).then(() => {});
}
