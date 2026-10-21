import { config } from './config';

export interface Author {
  userId: string;
  username: string;
  homeserver: string;
  displayName: string | null;
  isBot: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

export interface Message {
  id: string;
  channelId: string;
  guildId: string | null;
  content: string | null;
  nonce: string;
  replyTo: string | null;
  createdAt: string;
  pingedHandles?: string[];
  attachments: Attachment[];
  author: Author;
}

export interface Me {
  id: string;
  username: string;
  homeserver: string;
  handle: string;
  displayName: string | null;
}

export const handleOf = (user: { username: string; homeserver: string }) =>
  `@${user.username}:${user.homeserver}`.toLowerCase();

// Mirrors anchor/utils/mentions.ts so we see pings exactly the way the server does.
export function mentionHandles(content: string | null) {
  return new Set(
    [
      ...(content ?? '')
        .replace(/https?:\/\/[^\s]+/g, '')
        .matchAll(/(?<![a-zA-Z0-9._])@[a-zA-Z0-9._]+:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?/g),
    ].map(([handle]) => handle.toLowerCase())
  );
}

export class NovarumClient {
  private token: string | undefined = config.sessionToken;
  // Nonces of messages this process sent, so we never react to our own output — important when
  // the bot runs on your personal account and its replies are authored by "you".
  readonly sentNonces = new Set<string>();

  private get tokenFile() {
    return Bun.file(`${config.dataDir}/session_token`);
  }

  async login() {
    if (!this.token && (await this.tokenFile.exists())) {
      this.token = (await this.tokenFile.text()).trim();
    }
    if (this.token) {
      const me = await this.me().catch(() => null);
      if (me) return me;
      console.warn('Stored session token is invalid, logging in again');
      this.token = undefined;
    }
    if (!config.username || !config.password) {
      throw new Error('Set NOVARUM_SESSION_TOKEN or NOVARUM_USERNAME + NOVARUM_PASSWORD');
    }

    let res = await fetch(`${config.novarumUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: config.username, password: config.password }),
    });
    if (res.status === 202) {
      const { challenge, methods } = (await res.json()) as { challenge: string; methods: string[] };
      const method = methods.includes('TOTP') ? 'TOTP' : 'EMAIL';
      if (method === 'EMAIL') {
        await fetch(`${config.novarumUrl}/auth/login/mfa/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ challenge }),
        });
      }
      const code = prompt(`Novarum ${method} code:`)?.trim();
      if (!code) throw new Error('MFA code required');
      res = await fetch(`${config.novarumUrl}/auth/login/mfa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge, method, code }),
      });
    }
    if (!res.ok) throw new Error(`Novarum login failed: ${res.status} ${await res.text()}`);

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('session_token='));
    this.token = cookie?.split(';')[0]?.slice('session_token='.length);
    if (!this.token) throw new Error('Novarum login succeeded but returned no session_token cookie');
    await Bun.write(this.tokenFile, this.token);
    return this.me();
  }

  get cookie() {
    return `session_token=${this.token}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${config.novarumUrl}${path}`, {
      method,
      headers: {
        cookie: this.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async me() {
    const { user } = await this.request<{ user: Me | null }>('GET', '/auth/me');
    if (!user) throw new Error('Not logged in');
    return user;
  }

  async guilds() {
    const { guilds } = await this.request<{ guilds: { id: string; name: string }[] }>(
      'GET',
      '/guilds/list'
    );
    return guilds;
  }

  async listMessages(channelId: string, amount = 20) {
    const params = new URLSearchParams({
      channelId,
      cursor: '0',
      amount: String(Math.min(100, Math.max(20, amount))),
    });
    const { messages } = await this.request<{ messages: Message[] }>(
      'GET',
      `/message/list?${params}`
    );
    return messages;
  }

  async send(channelId: string, content: string, replyTo?: string) {
    const nonce = crypto.randomUUID();
    this.sentNonces.add(nonce);
    const { message } = await this.request<{ message: Message }>('POST', '/message/send', {
      channelId,
      content,
      nonce,
      ...(replyTo ? { replyTo } : {}),
    });
    return message;
  }

  async edit(channelId: string, messageId: string, content: string) {
    await this.request('POST', '/message/edit', { channelId, messageId, content });
  }

  async delete(channelId: string, messageId: string) {
    await this.request('POST', '/message/delete', { channelId, messageId });
  }

  async download(attachment: Attachment) {
    const res = await fetch(new URL(attachment.url, config.novarumUrl), { headers: { cookie: this.cookie } });
    if (!res.ok) throw new Error(`GET ${attachment.filename} -> ${res.status}`);
    return res.arrayBuffer();
  }

  async typing(channelId: string) {
    await this.request('POST', `/channel/${encodeURIComponent(channelId)}/typing`);
  }

  /** Connects to the realtime socket and keeps it connected, calling onMessage for every new message. */
  listen(onMessage: (message: Message) => void) {
    const wsUrl = `${config.novarumUrl.replace(/^http/, 'ws')}/realtime/`;
    let attempt = 0;

    const connect = () => {
      // Bun extends the WebSocket constructor with custom headers; the server reads the cookie.
      const ws = new WebSocket(wsUrl, { headers: { cookie: this.cookie } } as any);

      ws.addEventListener('open', async () => {
        attempt = 0;
        console.log('Realtime connected');
        // Don't count as an "active" client, so the account's real devices still get push.
        ws.send(JSON.stringify({ type: 'client.state', active: false }));
        // Local guilds are subscribed automatically; federated ones need an explicit subscribe.
        for (const guild of await this.guilds().catch(() => [])) {
          ws.send(JSON.stringify({ type: 'subscribe.guild', guildId: guild.id }));
        }
      });

      ws.addEventListener('message', (event) => {
        let data: { type?: string; data?: any };
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (data.type === 'message.created' && data.data) onMessage(data.data as Message);
        if (data.type === 'guild.created' && data.data?.id) {
          ws.send(JSON.stringify({ type: 'subscribe.guild', guildId: data.data.id }));
        }
      });

      ws.addEventListener('close', (event) => {
        const delay = Math.min(30_000, 1000 * 2 ** attempt++);
        console.warn(`Realtime closed (${event.code} ${event.reason}), reconnecting in ${delay}ms`);
        setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => ws.close());
    };

    connect();
  }
}
