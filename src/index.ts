import { config } from './config';
import { EFFORTS, isEffort, isExternalAgentMode, runAmp, threadUrl, type Effort } from './amp';
import { NovarumClient, handleOf, mentionHandles, type Message } from './novarum';
import { agentSettings, linkThread, setAgentSetting, threadFor } from './store';

const novarum = new NovarumClient();
const me = await novarum.login();
const myHandle = handleOf(me);
const triggerHandles = new Set([myHandle, ...config.extraTriggerHandles]);
const ownerHandle = config.ownerHandle ?? myHandle;

// Running runs, keyed by Amp thread ID (or the triggering message ID until Amp assigns one).
const running = new Map<string, AbortController>();

const MAX_CHUNK = 3800;
const PROGRESS_EVERY_MS = 4000;
const TYPING_EVERY_MS = 8000;

console.log(`Logged in as ${myHandle}`);
console.log(`Triggers: ${[...triggerHandles].join(', ')} | owner: ${ownerHandle}`);

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

// Leading `--model x` / `-m x` and `--effort x` / `-e x` flags pick the model and effort for one run.
function parseFlags(request: string) {
  const flags: { model?: string; effort?: string } = {};
  let rest = request;
  for (let match; (match = /^(--model|-m|--effort|-e)(?:=|\s+)(\S+)\s*/.exec(rest)); rest = rest.slice(match[0].length)) {
    flags[/^(--model|-m)$/.test(match[1]!) ? 'model' : 'effort'] = match[2]!;
  }
  return { ...flags, request: rest };
}

const describeAgent = (model: string | undefined, effort: string | undefined) =>
  [model ?? 'default model', `${effort ?? 'default'} effort`].join(' · ');

// `model`, `model <name>`, `model reset`, and the same for `effort`: show or change the defaults.
async function handleSettingCommand(message: Message, request: string) {
  const match = /^(model|effort)(?:\s+(\S+))?$/i.exec(request);
  if (!match) return false;
  const key = match[1]!.toLowerCase() as 'model' | 'effort';
  const value = match[2];
  const reply = (text: string) => novarum.send(message.channelId, text, message.id);

  if (key === 'model' && !isExternalAgentMode(config.ampMode)) {
    await reply(`The model can only be picked for external agents like Claude Code; \`${config.ampMode}\` picks its own.`);
    return true;
  }
  if (value && !/^(reset|default)$/i.test(value)) {
    if (key === 'effort' && !isEffort(value.toLowerCase())) {
      await reply(`Effort must be one of ${EFFORTS.map((e) => `\`${e}\``).join(', ')}.`);
      return true;
    }
    setAgentSetting(key, key === 'effort' ? value.toLowerCase() : value);
  } else if (value) {
    setAgentSetting(key, undefined);
  }
  const { model, effort } = agentSettings();
  await reply(`${value ? 'Now using' : 'Using'} ${describeAgent(model ?? config.ampModel, effort ?? config.ampEffort)}.`);
  return true;
}

// Novarum has no threads, only replies, so a reply chain plays the part of a Slack thread.
// Returns the chain above `message`, oldest first, as far back as `byId` reaches.
function replyChain(message: Message, byId: Map<string, Message>) {
  const chain: Message[] = [];
  const seen = new Set([message.id]);
  for (let m = message.replyTo ? byId.get(message.replyTo) : undefined; m && !seen.has(m.id); m = m.replyTo ? byId.get(m.replyTo) : undefined) {
    seen.add(m.id);
    chain.unshift(m);
  }
  return chain;
}

// Like mentioning @Amp anywhere in a Slack thread: the nearest message up the reply chain that
// belongs to an Amp thread decides which thread this message continues.
function threadInChain(message: Message, byId: Map<string, Message>) {
  const direct = threadFor(message.replyTo);
  if (direct) return direct;
  for (const m of replyChain(message, byId).reverse()) {
    const thread = threadFor(m.id);
    if (thread) return thread;
  }
}

const isOwn = (m: Message) => novarum.sentNonces.has(m.nonce);

function buildPrompt(message: Message, request: string, history: Message[], threadId: string | undefined) {
  const byId = new Map(history.map((m) => [m.id, m]));
  const chain = replyChain(message, byId);
  const lines: string[] = [];

  if (!threadId) {
    lines.push(
      `You were mentioned in Novarum, a chat app, by ${displayName(message.author)} (${handleOf(message.author)}) ` +
        `in a server channel. ` +
        `Your final answer is posted back into the chat as a markdown message, so keep it concise and ` +
        `lead with the outcome (links to PRs, commits, or files you changed are helpful). ` +
        `Replies to your messages, and further mentions in the same reply chain, continue this thread.`,
      ''
    );
    if (chain.length) {
      lines.push('The reply chain this message belongs to, oldest first (the conversation you were pulled into):', ...chain.map(formatMessage), '');
    }
    const inChain = new Set(chain.map((m) => m.id));
    const earlier = history.filter((m) => m.id !== message.id && !inChain.has(m.id)).slice(-config.contextMessages);
    if (earlier.length) {
      lines.push('Other recent messages in the channel, oldest first (for context only):', ...earlier.map(formatMessage), '');
    }
  } else {
    // Like a Slack thread, show what other people said since this Amp thread last heard from the chat.
    const lastSeen = history.findLastIndex((m) => m.id !== message.id && threadFor(m.id) === threadId);
    const since = history.slice(lastSeen + 1).filter((m) => m.id !== message.id && !isOwn(m));
    const repliedTo = message.replyTo ? byId.get(message.replyTo) : undefined;
    if (repliedTo && !isOwn(repliedTo) && !since.includes(repliedTo)) since.unshift(repliedTo);
    if (since.length) {
      lines.push('Messages posted in the chat since your last reply, oldest first:', ...since.map(formatMessage), '');
    }
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
  const repliesToThread = Boolean(threadFor(message.replyTo));
  // DMs are ignored entirely, mentions and replies included; the bot only works in server channels.
  if (message.guildId === null) return;
  if (!mentioned && !repliesToThread) return;

  if (author !== ownerHandle) {
    console.log(`Ignoring ${author}: not OWNER_HANDLE`);
    return;
  }

  const history = await novarum.listMessages(message.channelId, config.contextMessages).catch(() => []);
  const existingThread = threadInChain(message, new Map(history.map((m) => [m.id, m])));
  const flags = parseFlags(stripTriggers(message.content));
  const request = flags.request;

  if (await handleSettingCommand(message, request)) return;

  const model = flags.model ?? agentSettings().model ?? config.ampModel;
  const effort = (flags.effort ?? agentSettings().effort ?? config.ampEffort)?.toLowerCase();
  if (effort && !isEffort(effort)) {
    await novarum.send(message.channelId, `Effort must be one of ${EFFORTS.map((e) => `\`${e}\``).join(', ')}.`, message.id);
    return;
  }

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
  // Slack replies carry a byline saying whose Amp answered, plus the link to the Amp thread.
  const agent = isExternalAgentMode(config.ampMode) ? describeAgent(model, effort) : `${config.ampMode ?? 'Amp'}${effort ? ` · ${effort} effort` : ''}`;
  const byline = () => `\n\n*${displayName(message.author)}'s Amp* (${agent})${threadId ? ` · [Open in Amp](${threadUrl(threadId)})` : ''}`;

  const status = await novarum.send(message.channelId, `⏳ ${displayName(message.author)}'s Amp is working…`, message.id);
  if (existingThread) linkThread(existingThread, message.id);
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
    const prompt = buildPrompt(message, request, history, existingThread);
    console.log(`${author} -> ${existingThread ? `continue ${existingThread}` : 'new thread'}: ${request.slice(0, 80)}`);

    const result = await runAmp(
      prompt,
      {
        threadId: existingThread,
        title: request.split('\n')[0] || 'Novarum request',
        model,
        effort: effort as Effort | undefined,
        signal: controller.signal,
      },
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
    const parts = chunk(body + byline());
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
