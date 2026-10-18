import { config } from './config';
import { runAmp, threadUrl } from './amp';
import { NovarumClient, handleOf, mentionHandles, type Message } from './novarum';
import { linkThread, threadFor } from './store';

const novarum = new NovarumClient();
const me = await novarum.login();
const myHandle = handleOf(me);
const triggerHandles = new Set([myHandle, ...config.extraTriggerHandles]);
const allowedHandles = new Set(config.allowedHandles.length ? config.allowedHandles : [myHandle]);

// Running runs, keyed by Amp thread ID (or the triggering message ID until Amp assigns one).
const running = new Map<string, AbortController>();

const MAX_CHUNK = 3800;
const PROGRESS_EVERY_MS = 4000;
const TYPING_EVERY_MS = 8000;

console.log(`Logged in as ${myHandle}`);
console.log(`Triggers: ${[...triggerHandles].join(', ')} | allowed: ${[...allowedHandles].join(', ')}`);

const displayName = (author: Message['author']) => author.displayName || author.username;

function stripTriggers(content: string | null) {
  let text = content ?? '';
  for (const handle of triggerHandles) {
    text = text.replace(new RegExp(handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }
  return text.trim();
}

function formatMessage(message: Message) {
  const files = message.attachments.map((a) => `[attachment ${a.filename} (${a.contentType}): ${new URL(a.url, config.novarumUrl)}]`);
  return `${displayName(message.author)} (${handleOf(message.author)}): ${[message.content ?? '', ...files].filter(Boolean).join(' ')}`;
}

function chunk(text: string) {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    // Prefer breaking on a paragraph or line boundary so code blocks mostly stay intact.
    let cut = rest.lastIndexOf('\n\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function buildPrompt(message: Message, request: string, continuing: boolean) {
  const history = await novarum.listMessages(message.channelId, config.contextMessages).catch(() => []);
  const byId = new Map(history.map((m) => [m.id, m]));
  const repliedTo = message.replyTo ? byId.get(message.replyTo) : undefined;
  const lines: string[] = [];

  if (!continuing) {
    lines.push(
      `You were mentioned in Novarum, a chat app, by ${displayName(message.author)} (${handleOf(message.author)}) ` +
        `in a ${message.guildId ? 'server channel' : 'direct message'}. ` +
        `Your final answer is posted back into the chat as a markdown message, so keep it concise and ` +
        `lead with the outcome (links to PRs, commits, or files you changed are helpful).`,
      ''
    );
    const earlier = history.filter((m) => m.id !== message.id).slice(-config.contextMessages);
    if (earlier.length) {
      lines.push('Recent messages in the channel, oldest first (for context only):', ...earlier.map(formatMessage), '');
    }
  } else if (repliedTo && !novarum.sentNonces.has(repliedTo.nonce)) {
    lines.push('They are replying to this message:', formatMessage(repliedTo), '');
  }

  const files = message.attachments.map((a) => `- ${a.filename} (${a.contentType}): ${new URL(a.url, config.novarumUrl)}`);
  lines.push(`Request from ${displayName(message.author)}:`, request || '(no text; see context above)');
  if (files.length) lines.push('', 'Attached files (signed URLs, fetch them if relevant):', ...files);
  return lines.join('\n');
}

async function handle(message: Message) {
  if (novarum.sentNonces.has(message.nonce)) return;

  const author = handleOf(message.author);
  const mentioned = [...mentionHandles(message.content)].some((h) => triggerHandles.has(h));
  const existingThread = threadFor(message.replyTo);
  const isDmToBot = message.guildId === null && message.author.userId !== me.id;
  if (!mentioned && !existingThread && !isDmToBot) return;

  if (!allowedHandles.has(author)) {
    console.log(`Ignoring ${author}: not in ALLOWED_HANDLES`);
    return;
  }

  const request = stripTriggers(message.content);

  if (/^(stop|cancel)$/i.test(request)) {
    const controller = existingThread && running.get(existingThread);
    if (controller) controller.abort();
    else await novarum.send(message.channelId, 'Nothing is running in that thread.', message.id);
    return;
  }

  const runKey = existingThread ?? message.id;
  if (running.has(runKey)) {
    await novarum.send(message.channelId, `Still working on that thread. Reply \`stop\` to cancel it first.`, message.id);
    return;
  }

  const controller = new AbortController();
  running.set(runKey, controller);
  let threadId = existingThread;
  const linkLine = () => (threadId ? `\n[Open in Amp](${threadUrl(threadId)})` : '');

  const status = await novarum.send(message.channelId, `⏳ ${displayName(message.author)}'s Amp is working…`, message.id);
  let lastStatus = '';
  let lastEdit = 0;
  let pendingEdit: ReturnType<typeof setTimeout> | undefined;
  const editStatus = (text: string) => {
    lastStatus = text;
    if (pendingEdit) return;
    pendingEdit = setTimeout(async () => {
      pendingEdit = undefined;
      lastEdit = Date.now();
      await novarum
        .edit(message.channelId, status.id, `⏳ ${displayName(message.author)}'s Amp is working… ${lastStatus}${linkLine()}`)
        .catch((e) => console.warn('status edit failed', e.message));
    }, Math.max(0, PROGRESS_EVERY_MS - (Date.now() - lastEdit)));
  };

  void novarum.typing(message.channelId).catch(() => {});
  const typing = setInterval(() => void novarum.typing(message.channelId).catch(() => {}), TYPING_EVERY_MS);

  try {
    const prompt = await buildPrompt(message, request, Boolean(existingThread));
    console.log(`${author} -> ${existingThread ? `continue ${existingThread}` : 'new thread'}: ${request.slice(0, 80)}`);

    const result = await runAmp(
      prompt,
      { threadId: existingThread, title: request.split('\n')[0] || 'Novarum request', signal: controller.signal },
      {
        onThread: (id) => {
          threadId = id;
          running.delete(runKey);
          running.set(id, controller);
          linkThread(id, message.id, status.id);
          editStatus('');
        },
        onProgress: editStatus,
      }
    );

    clearTimeout(pendingEdit);
    pendingEdit = undefined;
    await novarum.delete(message.channelId, status.id).catch(() => {});

    const body = result.ok ? result.text : `⚠️ ${result.error}`;
    const parts = chunk(body + linkLine());
    let replyTo = message.id;
    for (const part of parts) {
      const sent = await novarum.send(message.channelId, part, replyTo);
      if (threadId) linkThread(threadId, sent.id);
      replyTo = sent.id;
    }
  } catch (error) {
    console.error('Run failed', error);
    await novarum
      .edit(message.channelId, status.id, `⚠️ ${error instanceof Error ? error.message : String(error)}${linkLine()}`)
      .catch(() => {});
  } finally {
    clearInterval(typing);
    clearTimeout(pendingEdit);
    running.delete(runKey);
    if (threadId) running.delete(threadId);
  }
}

novarum.listen((message) => {
  handle(message).catch((error) => console.error('Failed to handle message', message.id, error));
});
