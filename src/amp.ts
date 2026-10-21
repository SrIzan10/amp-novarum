import { execute, type StreamMessage } from '@ampcode/sdk';
import { rm } from 'node:fs/promises';
import { config } from './config';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);

const EXTERNAL_AGENT = 'external-agent:';
export const isExternalAgentMode = (mode: string | undefined) => Boolean(mode?.startsWith(EXTERNAL_AGENT));

export interface RunCallbacks {
  /** Called once Amp has assigned the thread ID. */
  onThread(threadId: string): void | Promise<void>;
  /** Called with a short human-readable description of what Amp is doing right now. */
  onProgress(status: string): void;
}

export type RunResult = { ok: true; threadId: string; text: string } | { ok: false; threadId?: string; error: string };

export const threadUrl = (threadId: string) => `${config.ampUrl}/threads/${threadId}`;

function describe(message: StreamMessage): string | undefined {
  if (message.type !== 'assistant') return;
  // Report the latest step in the message: a tool call says more than the narration before it.
  for (const block of [...message.message.content].reverse()) {
    if (block.type === 'tool_use') {
      const input = block.input as Record<string, unknown>;
      const detail = input.cmd ?? input.command ?? input.path ?? input.pattern ?? input.query ?? input.url;
      return `Using \`${block.name}\`${typeof detail === 'string' ? `: \`${detail.slice(0, 120)}\`` : ''}`;
    }
    if (block.type === 'text' && block.text.trim()) {
      return block.text.trim().split('\n')[0]!.slice(0, 200);
    }
  }
}

/** Runs one turn of Amp in an orb or on a runner, starting a new thread or continuing `threadId`. */
export async function runAmp(
  prompt: string,
  {
    threadId,
    title,
    model,
    effort,
    attach,
    signal,
  }: { threadId?: string; title?: string; model?: string; effort?: Effort; attach?: string[]; signal: AbortSignal },
  callbacks: RunCallbacks
): Promise<RunResult> {
  let currentThread = threadId;
  const external = isExternalAgentMode(config.ampMode);
  // The CLI has no flags for an external agent's model and effort; it reads them from the
  // externalAgent* defaults in its session.json, the ones the TUI's model picker sets. Each run
  // gets its own data dir so concurrent runs don't overwrite each other's picks.
  const dataHome = external ? `${config.dataDir}/amp-runs/${crypto.randomUUID()}` : undefined;
  try {
    if (dataHome) {
      await Bun.write(
        `${dataHome}/amp/session.json`,
        JSON.stringify({
          externalAgentKey: config.ampMode!.slice(EXTERNAL_AGENT.length),
          externalAgentModel: model,
          externalAgentEffort: effort,
        })
      );
    }
    for await (const message of execute({
      prompt,
      signal,
      options: {
        // A continued thread runs on its own executor (orb or runner) whatever is passed here.
        ...(config.ampRunnerId && !threadId
          ? { executor: 'runner' as const, runnerId: config.ampRunnerId, runnerDir: config.ampRunnerDir }
          : { executor: 'orb' as const, project: threadId ? undefined : config.ampProject }),
        continue: threadId ?? false,
        title: threadId ? undefined : title?.slice(0, 256),
        mode: config.ampMode,
        effort: external ? undefined : effort,
        visibility: config.ampVisibility,
        labels: threadId ? undefined : ['novarum'],
        noArchiveAfterExecute: true,
        // Local files the CLI uploads to the thread as attachments on this message.
        attach: attach?.length ? attach : undefined,
        env: { AMP_API_KEY: config.ampApiKey, ...(dataHome && { XDG_DATA_HOME: dataHome }) },
      },
    })) {
      if (message.session_id && message.session_id !== currentThread) {
        currentThread = message.session_id;
        await callbacks.onThread(currentThread);
      }
      if (message.type === 'result') {
        return message.is_error
          ? { ok: false, threadId: currentThread, error: message.error }
          : { ok: true, threadId: currentThread!, text: message.result };
      }
      const status = describe(message);
      if (status) callbacks.onProgress(status);
    }
    return { ok: false, threadId: currentThread, error: 'Amp exited without a result' };
  } catch (error) {
    if (signal.aborted) return { ok: false, threadId: currentThread, error: 'Stopped.' };
    return { ok: false, threadId: currentThread, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (dataHome) await rm(dataHome, { recursive: true, force: true }).catch(() => {});
  }
}
