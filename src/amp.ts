import { execute, type StreamMessage } from '@ampcode/sdk';
import { config } from './config';

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

/** Runs one turn of Amp in an orb, starting a new thread or continuing `threadId`. */
export async function runAmp(
  prompt: string,
  { threadId, title, signal }: { threadId?: string; title?: string; signal: AbortSignal },
  callbacks: RunCallbacks
): Promise<RunResult> {
  let currentThread = threadId;
  try {
    for await (const message of execute({
      prompt,
      signal,
      options: {
        executor: 'orb',
        continue: threadId ?? false,
        project: threadId ? undefined : config.ampProject,
        title: threadId ? undefined : title?.slice(0, 256),
        mode: config.ampMode,
        visibility: config.ampVisibility,
        labels: threadId ? undefined : ['novarum'],
        noArchiveAfterExecute: true,
        env: { AMP_API_KEY: config.ampApiKey },
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
  }
}
