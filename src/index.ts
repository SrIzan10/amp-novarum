import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  SlashCommandBuilder,
  type APIAttachment,
  type ButtonInteraction,
  type CommandInteraction,
  type AutocompleteInteraction,
  type Message,
} from '@novarum/sdk';
import { config } from './config';
import { EFFORTS, isEffort, isExternalAgentMode, runAmp, threadUrl, type Effort } from './amp';
import { agentSettings, linkThread, setAgentSetting, threadFor } from './store';

const client = new Client({ token: config.botToken, baseUrl: config.novarumUrl });
await client.login();
const me = client.user!;
const myHandle = me.tag.toLowerCase();
const triggerHandles = new Set([myHandle, ...config.extraTriggerHandles]);
const ownerHandle = config.ownerHandle;

// Running runs, keyed by Amp thread ID (or the triggering message ID until Amp assigns one).
const running = new Map<string, AbortController>();
// The same controllers keyed by the triggering message ID, which is what a Stop button carries.
const runByTrigger = new Map<string, AbortController>();

const MAX_CHUNK = 3800;
const PROGRESS_EVERY_MS = 4000;
const TYPING_EVERY_MS = 8000;
const STOP_PREFIX = 'stop:';
const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku'];

console.log(`Logged in as ${myHandle}`);
console.log(`Triggers: ${[...triggerHandles].join(', ')} | owner: ${ownerHandle}`);

const handleOf = (user: { tag: string }) => user.tag.toLowerCase();
const isOwner = (user: { tag: string }) => handleOf(user) === ownerHandle;
const displayName = (author: Message['author']) => author.displayName || author.username;
const isOwn = (m: Message) => m.author.id === me.id;
const replyToOf = (m: Message) => m.data.replyTo;

// Mirrors anchor/utils/mentions.ts so we see pings exactly the way the server does.
function mentionHandles(content: string) {
  return new Set(
    [
      ...content
        .replace(/https?:\/\/[^\s]+/g, '')
        .matchAll(/(?<![a-zA-Z0-9._])@[a-zA-Z0-9._]+:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?/g),
    ].map(([handle]) => handle.toLowerCase())
  );
}

function isTriggered(message: Message) {
  const pinged = (message.data.pingedHandles ?? []).map((h) => h.toLowerCase());
  return [...pinged, ...mentionHandles(message.content)].some((h) => triggerHandles.has(h));
}

function stripTriggers(content: string) {
  let text = content;
  for (const handle of triggerHandles) {
    text = text.replace(new RegExp(handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }
  return text.trim();
}

function formatMessage(message: Message) {
  const files = message.data.attachments.map(
    (a) => `[attachment ${a.filename} (${a.contentType}): ${new URL(a.url, config.novarumUrl)}]`
  );
  return `${displayName(message.author)} (${handleOf(message.author)}): ${[message.content, ...files].filter(Boolean).join(' ')}`;
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

const typing = (channelId: string) =>
  client.rest.post(`/channel/${encodeURIComponent(channelId)}/typing`).catch(() => {});

async function listMessages(channelId: string, amount: number) {
  return (await client.channel(channelId)?.messages(amount).catch(() => undefined)) ?? [];
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

// Shows (no value) or changes (a value, or `reset`) the model or effort default, returning what to
// tell the owner. Shared by the `/model` and `/effort` slash commands and `@bot model …` in chat.
function applySetting(key: 'model' | 'effort', value: string | null | undefined) {
  if (key === 'model' && !isExternalAgentMode(config.ampMode)) {
    return `The model can only be picked for external agents like Claude Code; \`${config.ampMode}\` picks its own.`;
  }
  if (value && !/^(reset|default)$/i.test(value)) {
    if (key === 'effort' && !isEffort(value.toLowerCase())) {
      return `Effort must be one of ${EFFORTS.map((e) => `\`${e}\``).join(', ')}.`;
    }
    setAgentSetting(key, key === 'effort' ? value.toLowerCase() : value);
  } else if (value) {
    setAgentSetting(key, undefined);
  }
  const { model, effort } = agentSettings();
  return `${value ? 'Now using' : 'Using'} ${describeAgent(model ?? config.ampModel, effort ?? config.ampEffort)}.`;
}

// `model`, `model <name>`, `model reset`, and the same for `effort`.
async function handleSettingCommand(message: Message, request: string) {
  const match = /^(model|effort)(?:\s+(\S+))?$/i.exec(request);
  if (!match) return false;
  await message.reply(applySetting(match[1]!.toLowerCase() as 'model' | 'effort', match[2]));
  return true;
}

// Novarum has no threads, only replies, so a reply chain plays the part of a Slack thread.
// Returns the chain above `message`, oldest first, as far back as `byId` reaches.
function replyChain(message: Message, byId: Map<string, Message>) {
  const chain: Message[] = [];
  const seen = new Set([message.id]);
  const parent = (m: Message) => (replyToOf(m) ? byId.get(replyToOf(m)!) : undefined);
  for (let m = parent(message); m && !seen.has(m.id); m = parent(m)) {
    seen.add(m.id);
    chain.unshift(m);
  }
  return chain;
}

// Like mentioning @Amp anywhere in a Slack thread: the nearest message up the reply chain that
// belongs to an Amp thread decides which thread this message continues.
function threadInChain(message: Message, byId: Map<string, Message>) {
  const direct = threadFor(replyToOf(message));
  if (direct) return direct;
  for (const m of replyChain(message, byId).reverse()) {
    const thread = threadFor(m.id);
    if (thread) return thread;
  }
}

// Files on Novarum itself need the bot's token; a signed URL on another host must never get it.
async function download(attachment: APIAttachment) {
  const url = new URL(attachment.url, config.novarumUrl);
  const own = url.origin === new URL(config.novarumUrl).origin;
  const res = await fetch(url, own ? { headers: { authorization: `Bot ${config.botToken}` } } : undefined);
  if (!res.ok) throw new Error(`GET ${attachment.filename} -> ${res.status}`);
  return res.arrayBuffer();
}

// Downloads files so the Amp CLI can upload them to the thread as attachments. Returns the ones
// that made it, by local path; a file that fails to download stays a signed URL in the prompt.
async function downloadAttachments(attachments: APIAttachment[], dir: string) {
  const local = new Map<APIAttachment, string>();
  for (const [i, attachment] of attachments.entries()) {
    // One subdirectory per file keeps its original name, which is what Amp shows on the upload.
    const path = resolve(dir, String(i), attachment.filename.replace(/[/\\]/g, '_') || 'file');
    try {
      await Bun.write(path, await download(attachment));
      local.set(attachment, path);
    } catch (error) {
      console.warn(`Couldn't download ${attachment.filename}:`, error instanceof Error ? error.message : error);
    }
  }
  return local;
}

function buildPrompt(
  message: Message,
  request: string,
  history: Message[],
  threadId: string | undefined,
  attachments: APIAttachment[],
  uploaded: Map<APIAttachment, string>
) {
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
    const parentId = replyToOf(message);
    const repliedTo = parentId ? byId.get(parentId) : undefined;
    if (repliedTo && !isOwn(repliedTo) && !since.includes(repliedTo)) since.unshift(repliedTo);
    if (since.length) {
      lines.push('Messages posted in the chat since your last reply, oldest first:', ...since.map(formatMessage), '');
    }
  }

  const files = attachments.map(
    (a) => `- ${a.filename} (${a.contentType}): ${uploaded.has(a) ? 'attached to this message' : new URL(a.url, config.novarumUrl)}`
  );
  lines.push(`Request from ${displayName(message.author)}:`, request || '(no text; see context above)');
  if (files.length) {
    lines.push('', 'Files on the request and the message it replies to (signed URLs, fetch them if relevant):', ...files);
  }
  return lines.join('\n');
}

const stopRow = (triggerId: string) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Stop').setStyle(ButtonStyle.Danger).setCustomId(`${STOP_PREFIX}${triggerId}`)
  );

const openInAmpRow = (threadId: string) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Open in Amp').setStyle(ButtonStyle.Link).setURL(threadUrl(threadId))
  );

const failureEmbed = (error: string) =>
  new EmbedBuilder().setTitle('Amp run failed').setDescription(error.slice(0, MAX_CHUNK)).setColor('#ed4245');

async function handle(message: Message) {
  if (isOwn(message) || message.author.bot) return;
  // DMs are ignored entirely, mentions and replies included; the bot only works in server channels.
  if (message.guildId === null) return;

  const author = handleOf(message.author);
  const repliesToThread = Boolean(threadFor(replyToOf(message)));
  if (!isTriggered(message) && !repliesToThread) return;

  if (!isOwner(message.author)) {
    console.log(`Ignoring ${author}: not OWNER_HANDLE`);
    return;
  }

  const history = await listMessages(message.channelId, config.contextMessages);
  const byId = new Map(history.map((m) => [m.id, m]));
  const existingThread = threadInChain(message, byId);
  const flags = parseFlags(stripTriggers(message.content));
  const request = flags.request;

  if (await handleSettingCommand(message, request)) return;

  const model = flags.model ?? agentSettings().model ?? config.ampModel;
  const effort = (flags.effort ?? agentSettings().effort ?? config.ampEffort)?.toLowerCase();
  if (effort && !isEffort(effort)) {
    await message.reply(`Effort must be one of ${EFFORTS.map((e) => `\`${e}\``).join(', ')}.`);
    return;
  }

  if (/^(stop|cancel)$/i.test(request)) {
    const controller = existingThread && running.get(existingThread);
    if (controller) controller.abort();
    else await message.reply('Nothing is running in that thread.');
    return;
  }

  const runKey = existingThread ?? message.id;
  if (running.has(runKey)) {
    await message.reply('Still working on that thread. Press Stop on its status message, or reply `stop`, to cancel it first.');
    return;
  }

  const controller = new AbortController();
  running.set(runKey, controller);
  runByTrigger.set(message.id, controller);
  let threadId = existingThread;
  // Slack replies carry a byline saying whose Amp answered; the link to the Amp thread is a button.
  const agent = isExternalAgentMode(config.ampMode) ? describeAgent(model, effort) : `${config.ampMode ?? 'Amp'}${effort ? ` · ${effort} effort` : ''}`;
  const byline = `\n\n*${displayName(message.author)}'s Amp* (${agent})`;
  const workingLine = `⏳ ${displayName(message.author)}'s Amp is working…`;

  const status = await message.reply({ content: workingLine, components: [stopRow(message.id)] });
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
      // Once Stop has been pressed the button stays gone.
      const stopped = controller.signal.aborted;
      await status
        .edit({
          content: stopped ? '⏹️ Stopping…' : `${workingLine} ${lastStatus}`,
          components: stopped ? [] : [stopRow(message.id)],
        })
        .catch((e) => console.warn('status edit failed', e.message));
    }, Math.max(0, PROGRESS_EVERY_MS - (Date.now() - lastEdit)));
  };

  // Replying to a message with an image (or any file) hands that file to Amp along with the request.
  const parentId = replyToOf(message);
  const repliedTo = parentId ? byId.get(parentId) : undefined;
  const attachments = [...message.data.attachments, ...(repliedTo?.data.attachments ?? [])];
  const attachmentDir = `${config.dataDir}/attachments/${crypto.randomUUID()}`;

  void typing(message.channelId);
  const typingTimer = setInterval(() => void typing(message.channelId), TYPING_EVERY_MS);

  try {
    const uploaded = await downloadAttachments(attachments, attachmentDir);
    const prompt = buildPrompt(message, request, history, existingThread, attachments, uploaded);
    console.log(`${author} -> ${existingThread ? `continue ${existingThread}` : 'new thread'}: ${request.slice(0, 80)}`);

    const result = await runAmp(
      prompt,
      {
        threadId: existingThread,
        title: request.split('\n')[0] || 'Novarum request',
        model,
        effort: effort as Effort | undefined,
        attach: [...uploaded.values()],
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
    await status.delete().catch(() => {});

    const sendReply = async (options: Parameters<Message['reply']>[0], replyTo: Message) => {
      const sent = await replyTo.reply(options);
      if (threadId) linkThread(threadId, sent.id);
      return sent;
    };
    const link = threadId ? [openInAmpRow(threadId)] : [];

    if (!result.ok && controller.signal.aborted) {
      await sendReply({ content: `⏹️ Stopped.${byline}`, components: link }, message);
    } else if (!result.ok) {
      await sendReply({ embeds: [failureEmbed(result.error)], content: byline.trim(), components: link }, message);
    } else {
      // The Open in Amp button rides on the last part of the answer.
      const parts = chunk(result.text + byline);
      let replyTo = message;
      for (const [i, part] of parts.entries()) {
        replyTo = await sendReply({ content: part, components: i === parts.length - 1 ? link : [] }, replyTo);
      }
    }
  } catch (error) {
    console.error('Run failed', error);
    await status
      .edit({
        content: null,
        embeds: [failureEmbed(error instanceof Error ? error.message : String(error))],
        components: threadId ? [openInAmpRow(threadId)] : [],
      })
      .catch(() => {});
  } finally {
    clearInterval(typingTimer);
    clearTimeout(pendingEdit);
    await rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
    running.delete(runKey);
    runByTrigger.delete(message.id);
    if (threadId) running.delete(threadId);
  }
}

// --- Slash commands and buttons ---

const commands = [
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Show or change the model Claude Code runs with')
    .addStringOption((o) =>
      o.setName('name').setDescription('An alias (opus, sonnet, haiku), a model ID, or reset').setAutocomplete()
    ),
  new SlashCommandBuilder()
    .setName('effort')
    .setDescription('Show or change how much effort the agent puts in')
    .addStringOption((o) =>
      o
        .setName('level')
        .setDescription('The effort level, or reset')
        .addChoices(...[...EFFORTS, 'reset'].map((value) => ({ name: value, value })))
    ),
];

async function handleCommand(interaction: CommandInteraction) {
  if (!isOwner(interaction.user)) {
    await interaction.reply({ content: `Only ${ownerHandle} can change the settings.`, ephemeral: true });
    return;
  }
  const key = interaction.commandName === 'model' ? 'model' : interaction.commandName === 'effort' ? 'effort' : undefined;
  if (!key) return;
  const value = interaction.options.getString(key === 'model' ? 'name' : 'level');
  await interaction.reply({ content: applySetting(key, value), ephemeral: true });
}

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  if (interaction.commandName !== 'model') return;
  const typed = interaction.options.getFocused().value.toLowerCase();
  const choices = [...MODEL_SUGGESTIONS, 'reset'].filter((name) => name.includes(typed));
  // A model ID that isn't an alias is still accepted as typed.
  if (typed && !choices.includes(typed)) choices.push(interaction.options.getFocused().value);
  await interaction.respond(choices.map((name) => ({ name, value: name })));
}

async function handleButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith(STOP_PREFIX)) return;
  if (!isOwner(interaction.user)) {
    await interaction.reply({ content: `Only ${ownerHandle} can stop runs.`, ephemeral: true });
    return;
  }
  const controller = runByTrigger.get(interaction.customId.slice(STOP_PREFIX.length));
  if (!controller) {
    await interaction.reply({ content: 'That run has already finished.', ephemeral: true });
    return;
  }
  controller.abort();
  await interaction.update({ content: '⏹️ Stopping…', components: [] });
}

client.on('messageCreate', (message) => {
  handle(message).catch((error) => console.error('Failed to handle message', message.id, error));
});

client.on('interactionCreate', (interaction) => {
  const done = interaction.isCommand()
    ? handleCommand(interaction)
    : interaction.isButton()
      ? handleButton(interaction)
      : interaction.isAutocomplete()
        ? handleAutocomplete(interaction)
        : undefined;
  done?.catch((error) => console.error('Failed to handle interaction', interaction.id, error));
});

client.on('error', (error) => console.error('Novarum client error', error));
client.on('disconnect', (code, reason) => console.warn(`Realtime closed (${code} ${reason})`));

await client.commands.set(commands);
