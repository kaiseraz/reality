import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  BoardTask,
  BoardTaskStatus,
  ChatCard,
  ChatKind,
  ChatMessage,
  ChatSummary,
} from '@reality/schemas';

const MAX_MEMORY = 50;

interface ChatRow {
  id: string;
  owner_id: string | null;
  kind: ChatKind;
  title: string;
  bot_ids: string[];
  home_bot: string | null;
  host_folder: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Chat {
  id: string;
  ownerId: string | null;
  kind: ChatKind;
  title: string;
  botIds: string[];
  /** The folder on the person's computer that this chat's work is copied to. */
  hostFolder: string | null;
  updatedAt: string;
}

const toChat = (r: ChatRow): Chat => ({
  id: r.id,
  ownerId: r.owner_id,
  kind: r.kind,
  title: r.title,
  botIds: r.bot_ids,
  hostFolder: r.host_folder,
  updatedAt: r.updated_at.toISOString(),
});

interface MessageRow {
  id: string;
  role: ChatMessage['role'];
  bot_id: string | null;
  text: string;
  card: ChatCard | null;
  created_at: Date;
}

const toMessage = (r: MessageRow): ChatMessage => ({
  id: Number(r.id),
  role: r.role,
  botId: r.bot_id,
  text: r.text,
  card: r.card,
  createdAt: r.created_at.toISOString(),
});

/** Persistence for chats, their messages, task boards, started Reality tasks and bot memory. */
export class ChatStore {
  constructor(readonly pool: pg.Pool) {}

  /**
   * The direct chat with a bot, created on first use. Only a chat that is still a DM
   * counts: handing a hired group back as "the DM" would send every new message into
   * the old team. A group that grew out of a DM stays reachable by its own chat id
   * (sidebar), never through this lookup.
   */
  async dmFor(botId: string, ownerId: string | null, botName: string): Promise<Chat> {
    const dm = await this.pool.query<ChatRow>(
      `SELECT * FROM chats WHERE home_bot = $1 AND owner_id IS NOT DISTINCT FROM $2 AND kind = 'dm'
        ORDER BY created_at DESC LIMIT 1`,
      [botId, ownerId],
    );
    if (dm.rows[0]) return toChat(dm.rows[0]);
    return this.create(ownerId, 'dm', botName, [botId]);
  }

  async create(
    ownerId: string | null,
    kind: ChatKind,
    title: string,
    botIds: string[],
  ): Promise<Chat> {
    const id = randomUUID();
    const { rows } = await this.pool.query<ChatRow>(
      `INSERT INTO chats (id, owner_id, kind, title, bot_ids, home_bot)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        id,
        ownerId,
        kind,
        title.slice(0, 80),
        JSON.stringify(botIds),
        kind === 'dm' ? (botIds[0] ?? null) : null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('chat not stored');
    return toChat(row);
  }

  async get(id: string, ownerId?: string | null): Promise<Chat | undefined> {
    const { rows } = await this.pool.query<ChatRow>(
      ownerId === undefined
        ? 'SELECT * FROM chats WHERE id = $1'
        : 'SELECT * FROM chats WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2',
      ownerId === undefined ? [id] : [id, ownerId],
    );
    return rows[0] ? toChat(rows[0]) : undefined;
  }

  async list(ownerId: string | null): Promise<ChatSummary[]> {
    const { rows } = await this.pool.query<
      ChatRow & { last: string | null; first_user: string | null; home_name: string | null }
    >(
      `SELECT c.*, (SELECT m.text FROM chat_messages m
                     WHERE m.chat_id = c.id AND m.role IN ('user', 'bot')
                     ORDER BY m.id DESC LIMIT 1) AS last,
                   (SELECT m.text FROM chat_messages m
                     WHERE m.chat_id = c.id AND m.role = 'user'
                     ORDER BY m.id ASC LIMIT 1) AS first_user,
                   (SELECT b.name FROM bots b WHERE b.id = c.home_bot) AS home_name
         FROM chats c WHERE c.owner_id IS NOT DISTINCT FROM $1 ORDER BY c.updated_at DESC`,
      [ownerId],
    );
    return rows.map((r) => {
      // A chat still carrying a placeholder title (the bot's name, or "New chat") is
      // shown under its job: the first thing the user asked in it.
      const placeholder =
        r.title === 'New chat' || (r.home_name !== null && r.title === r.home_name);
      const title =
        placeholder && r.first_user ? r.first_user.replace(/\s+/g, ' ').slice(0, 80) : r.title;
      return {
        id: r.id,
        kind: r.kind,
        title,
        botIds: r.bot_ids,
        homeBot: r.home_bot,
        updatedAt: r.updated_at.toISOString(),
        last: (r.last ?? '').slice(0, 140),
      };
    });
  }

  /** Who takes part: hiring a team turns a direct chat with the lead into a group. */
  async setMembers(id: string, botIds: string[], title?: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET bot_ids = $2, kind = CASE WHEN jsonb_array_length($2::jsonb) > 1
              THEN 'group' ELSE kind END, title = COALESCE($3, title), updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(botIds), title ? title.slice(0, 80) : null],
    );
  }

  async setHostFolder(id: string, path: string): Promise<void> {
    await this.pool.query('UPDATE chats SET host_folder = $2 WHERE id = $1', [id, path]);
  }

  /** What a chat is about: its title, or its first message while the title is a placeholder. */
  async subject(chat: Chat): Promise<string> {
    if (chat.kind !== 'dm' && chat.title !== 'New chat') return chat.title;
    const { rows } = await this.pool.query<{ text: string }>(
      `SELECT text FROM chat_messages WHERE chat_id = $1 AND role = 'user' ORDER BY id LIMIT 1`,
      [chat.id],
    );
    return rows[0]?.text ?? chat.title;
  }

  /** Names a conversation after what it is about (its first user message). */
  async rename(id: string, title: string): Promise<void> {
    await this.pool.query('UPDATE chats SET title = $2 WHERE id = $1', [id, title.slice(0, 80)]);
  }

  async remove(id: string, ownerId: string | null): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM chats WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2',
      [id, ownerId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ---- Messages ---------------------------------------------------------------------------

  async messages(chatId: string, limit = 200): Promise<ChatMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM (SELECT * FROM chat_messages WHERE chat_id = $1 ORDER BY id DESC LIMIT $2) m
        ORDER BY id`,
      [chatId, limit],
    );
    return rows.map(toMessage);
  }

  async message(id: number): Promise<(ChatMessage & { chatId: string }) | undefined> {
    const { rows } = await this.pool.query<MessageRow & { chat_id: string }>(
      'SELECT * FROM chat_messages WHERE id = $1',
      [id],
    );
    return rows[0] ? { ...toMessage(rows[0]), chatId: rows[0].chat_id } : undefined;
  }

  async add(
    chatId: string,
    m: { role: ChatMessage['role']; botId?: string | null; text?: string; card?: ChatCard | null },
  ): Promise<ChatMessage> {
    const { rows } = await this.pool.query<MessageRow>(
      `INSERT INTO chat_messages (chat_id, role, bot_id, text, card) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [chatId, m.role, m.botId ?? null, (m.text ?? '').slice(0, 20_000), m.card ?? null],
    );
    await this.pool.query('UPDATE chats SET updated_at = now() WHERE id = $1', [chatId]);
    const row = rows[0];
    if (!row) throw new Error('message not stored');
    return toMessage(row);
  }

  async setCard(messageId: number, card: ChatCard): Promise<void> {
    await this.pool.query('UPDATE chat_messages SET card = $2 WHERE id = $1', [messageId, card]);
  }

  // ---- Task board -------------------------------------------------------------------------

  async tasks(chatId: string): Promise<BoardTask[]> {
    const { rows } = await this.pool.query<{
      id: number;
      title: string;
      owner_bot: string | null;
      status: BoardTaskStatus;
      note: string;
      updated_at: Date;
    }>('SELECT * FROM chat_tasks WHERE chat_id = $1 ORDER BY id', [chatId]);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      ownerBot: r.owner_bot,
      status: r.status,
      note: r.note,
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  async createTask(chatId: string, title: string, ownerBot: string | null): Promise<BoardTask> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO chat_tasks (chat_id, id, title, owner_bot, status)
       VALUES ($1, (SELECT COALESCE(MAX(id), 0) + 1 FROM chat_tasks WHERE chat_id = $1), $2, $3, 'open')
       RETURNING id`,
      [chatId, title.slice(0, 200), ownerBot],
    );
    const id = rows[0]?.id ?? 0;
    const task = (await this.tasks(chatId)).find((t) => t.id === id);
    if (!task) throw new Error('task not stored');
    return task;
  }

  async updateTask(
    chatId: string,
    id: number,
    patch: { status?: BoardTaskStatus; ownerBot?: string; title?: string; note?: string },
  ): Promise<BoardTask | undefined> {
    await this.pool.query(
      `UPDATE chat_tasks SET status = COALESCE($3, status), owner_bot = COALESCE($4, owner_bot),
              title = COALESCE($5, title), note = COALESCE($6, note), updated_at = now()
        WHERE chat_id = $1 AND id = $2`,
      [
        chatId,
        id,
        patch.status ?? null,
        patch.ownerBot ?? null,
        patch.title ?? null,
        patch.note ?? null,
      ],
    );
    return (await this.tasks(chatId)).find((t) => t.id === id);
  }

  // ---- Reality tasks started from chats -----------------------------------------------------

  async addRun(chatId: string, taskId: string, botId: string | null): Promise<void> {
    await this.pool.query(
      'INSERT INTO chat_runs (chat_id, task_id, bot_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [chatId, taskId, botId],
    );
  }

  /** Runs whose final result has not been reported yet, with the task's current status. */
  async openRuns(): Promise<
    {
      chatId: string;
      taskId: string;
      botId: string | null;
      reported: string | null;
      status: string;
    }[]
  > {
    const { rows } = await this.pool.query<{
      chat_id: string;
      task_id: string;
      bot_id: string | null;
      reported: string | null;
      status: string;
    }>(
      `SELECT r.chat_id, r.task_id, r.bot_id, r.reported, t.status
         FROM chat_runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.reported IS DISTINCT FROM 'final'`,
    );
    return rows.map((r) => ({
      chatId: r.chat_id,
      taskId: r.task_id,
      botId: r.bot_id,
      reported: r.reported,
      status: r.status,
    }));
  }

  async markRun(chatId: string, taskId: string, reported: string): Promise<void> {
    await this.pool.query(
      'UPDATE chat_runs SET reported = $3 WHERE chat_id = $1 AND task_id = $2',
      [chatId, taskId, reported],
    );
  }

  /** The message that shows a task's plan card, to update it in place. */
  async planCard(chatId: string, taskId: string): Promise<ChatMessage | undefined> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM chat_messages WHERE chat_id = $1 AND card->>'kind' = 'plan'
          AND card->>'taskId' = $2 ORDER BY id DESC LIMIT 1`,
      [chatId, taskId],
    );
    return rows[0] ? toMessage(rows[0]) : undefined;
  }

  /** The card waiting for a decision on a task (its plan or a library to install). */
  async decisionCard(chatId: string, taskId: string): Promise<ChatMessage | undefined> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM chat_messages WHERE chat_id = $1 AND card->>'kind' IN ('plan', 'install')
          AND card->>'taskId' = $2 AND card->>'status' = 'waiting' ORDER BY id DESC LIMIT 1`,
      [chatId, taskId],
    );
    return rows[0] ? toMessage(rows[0]) : undefined;
  }

  // ---- Memory ---------------------------------------------------------------------------

  async remember(botId: string, text: string, chatId: string): Promise<void> {
    await this.pool.query('INSERT INTO bot_memory (bot_id, chat_id, text) VALUES ($1, $2, $3)', [
      botId,
      chatId,
      text.slice(0, 500),
    ]);
    await this.pool.query(
      `DELETE FROM bot_memory WHERE bot_id = $1 AND chat_id = $2 AND id NOT IN
         (SELECT id FROM bot_memory WHERE bot_id = $1 AND chat_id = $2 ORDER BY id DESC LIMIT $3)`,
      [botId, chatId, MAX_MEMORY],
    );
  }

  /**
   * What a bot remembers in one chat. Memory used to be global per bot, so facts
   * from an old job (a CubeSat) leaked into every new conversation (a jet engine).
   * Legacy rows without a chat stay unread: they belong to a finished context.
   */
  async memory(botId: string, chatId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ text: string }>(
      'SELECT text FROM bot_memory WHERE bot_id = $1 AND chat_id = $2 ORDER BY id',
      [botId, chatId],
    );
    return rows.map((r) => r.text);
  }
}
