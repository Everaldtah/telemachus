/**
 * Minimal Telegram Bot API client (dependency-free, global fetch). Long-polls
 * getUpdates and exposes the handful of methods Telemachus needs. Messages are sent
 * as plain text (no parse_mode) so arbitrary code/output never breaks formatting;
 * long messages are split at Telegram's 4096-char limit by the caller.
 */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}
export interface TgChat {
  id: number;
  type: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  date?: number;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export class TelegramClient {
  private base: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call(method: string, params: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  async getMe(): Promise<TgUser> {
    return this.call("getMe", {});
  }

  /** Long-poll for updates. timeout is server-side (seconds). */
  async getUpdates(offset: number, timeout = 50): Promise<TgUpdate[]> {
    const res = await fetch(`${this.base}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, timeout, allowed_updates: ["message", "callback_query"] }),
    });
    const json: any = await res.json().catch(() => ({ ok: false }));
    return json.ok ? (json.result as TgUpdate[]) : [];
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: { buttons?: InlineButton[][]; disablePreview?: boolean } = {}
  ): Promise<TgMessage> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, 4096) || "…",
      disable_web_page_preview: opts.disablePreview ?? true,
    };
    if (opts.buttons) params.reply_markup = { inline_keyboard: opts.buttons };
    return this.call("sendMessage", params);
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { buttons?: InlineButton[][] } = {}
  ): Promise<void> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4096) || "…",
      disable_web_page_preview: true,
    };
    if (opts.buttons) params.reply_markup = { inline_keyboard: opts.buttons };
    try {
      await this.call("editMessageText", params);
    } catch (err) {
      // "message is not modified" is benign; ignore so throttled edits don't crash.
      if (!/not modified/i.test((err as Error).message)) throw err;
    }
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, text: text ?? "" }).catch(() => {});
  }

  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action }).catch(() => {});
  }

  /** Register the slash-command menu so typing "/" in chat shows the options. */
  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call("setMyCommands", { commands }).catch(() => {});
  }
}

/** Split a long string into <=4096-char chunks on line boundaries where possible. */
export function chunkMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > limit) {
      if (cur) chunks.push(cur);
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
        cur = "";
      } else cur = line;
    } else {
      cur = cur ? cur + "\n" + line : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
