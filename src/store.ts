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
