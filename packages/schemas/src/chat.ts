import { z } from 'zod';

/**
 * Chats with bots (adapted from Astra, in the spirit of Grok Bot): you talk to a bot like a
 * colleague, it works with tools until it is done, and in a group the bots hand work to
 * each other. Every number a bot reports must come from a tool result; Reality marks the
 * ones that do not.
 */

export const ChatKind = z.enum(['dm', 'group']);
export type ChatKind = z.infer<typeof ChatKind>;

export const CreateGroupRequest = z.object({
  title: z.string().trim().min(1).max(80),
  botIds: z.array(z.uuid()).min(2).max(6),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>;

/**
 * A new conversation: a group of bots, or a direct chat with one bot. The direct form is
 * how a user opens another chat with the lead; the older singleton DM (dmFor) stays as
 * the first of them.
 */
export const CreateChatRequest = z
  .object({
    title: z.string().trim().min(1).max(80),
    botIds: z.array(z.uuid()).min(1).max(6),
    kind: ChatKind.default('group'),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'dm' && v.botIds.length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'A direct chat has exactly one bot.' });
    }
    if (v.kind === 'group' && v.botIds.length < 2) {
      ctx.addIssue({ code: 'custom', message: 'A group chat needs at least two bots.' });
    }
  });
export type CreateChatRequest = z.infer<typeof CreateChatRequest>;

export const SendMessageRequest = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** An example dataset to attach to the conversation (sample id). */
  sample: z.string().max(40).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const AnswerRequest = z.object({ answer: z.string().trim().min(1).max(4000) });

/** Renaming a conversation from its menu. */
export const RenameChatRequest = z.object({ title: z.string().trim().min(1).max(80) });
export type RenameChatRequest = z.infer<typeof RenameChatRequest>;

export const BoardTaskStatus = z.enum(['open', 'doing', 'waiting', 'done']);
export type BoardTaskStatus = z.infer<typeof BoardTaskStatus>;

export const UpdateBoardTaskRequest = z.object({
  status: BoardTaskStatus.optional(),
  ownerBot: z.uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

/** What a bot is doing right now; drives its animated figure. */
export const Presence = z.enum([
  'idle',
  'thinking',
  'talking',
  'working',
  'searching',
  'reading',
  'waiting',
  'celebrate',
]);
export type Presence = z.infer<typeof Presence>;

/**
 * How code decides that a contract is met. command: a check command on the bot's computer
 * must exit 0; file: a file on its computer exists (and contains a pattern); task: a Reality
 * task of the bot passed independent verification; review: the person decides.
 */
export const ContractCheck = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), command: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal('file'),
    path: z.string().min(1).max(500),
    contains: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal('task') }),
  // A person decides, after code: the command runs first, and only work that passes it is shown.
  z.object({ type: z.literal('review'), command: z.string().min(1).max(2000).optional() }),
]);
export type ContractCheck = z.infer<typeof ContractCheck>;

export type ContractStatus = 'active' | 'review' | 'met' | 'failed' | 'released';

/** One specialist in a team proposal (a new bot, or a resting one hired again). */
export const TeamMember = z.object({
  name: z.string().trim().min(1).max(40),
  role: z.enum(['analyst', 'researcher', 'engineer', 'reviewer', 'lead']),
  /** Hire a resting bot again instead of a new one. */
  reuseBotId: z.string().optional(),
  mission: z.string().trim().min(1).max(1000),
  deliverable: z.string().trim().min(1).max(500),
  check: ContractCheck,
  budgetMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  /** Web domains its computer may reach (granted when the team is hired). */
  domains: z.array(z.string().max(200)).max(10).default([]),
  /** Shell command that prepares its computer (e.g. pip install …), run once at hiring. */
  setup: z.string().max(2000).optional(),
});
export type TeamMember = z.infer<typeof TeamMember>;

export type ChatCard =
  | {
      kind: 'plan';
      taskId: string;
      request: string;
      steps: string[];
      status: 'waiting' | 'approved' | 'denied' | 'running';
    }
  | {
      kind: 'result';
      taskId: string;
      request: string;
      status: string;
      lines: string[];
      answer?: string;
      /** Machine checks: passed of total; review: criteria only a person can judge. */
      verified: { passed: number; total: number; review: number };
    }
  | {
      kind: 'sources';
      query: string;
      items: {
        ref: string;
        title: string;
        year: number | null;
        authors: string;
        url: string | null;
        citedBy: number;
      }[];
    }
  | { kind: 'knowledge'; query: string; items: { source: string; line: number; text: string }[] }
  | {
      /** A bot asks for its computer to reach a domain; the person allows or denies. */
      kind: 'access';
      domain: string;
      /** The tool server this is for; without it, the bot's computer. */
      server?: string;
      reason: string;
      status: 'open' | 'allowed' | 'denied';
    }
  | {
      kind: 'question';
      question: string;
      options: string[];
      status: 'open' | 'answered';
      answer?: string;
    }
  | {
      kind: 'widget';
      style: 'checklist' | 'metrics' | 'links';
      title: string;
      items: { label: string; value?: string; done?: boolean; url?: string }[];
    }
  | {
      kind: 'page';
      pageId: string;
      title: string;
      version: number;
      change: string;
      /** The start of the document, shown in the chat; older cards have none. */
      preview?: string;
      author?: string;
    }
  | { kind: 'code'; purpose: string; code: string; status: string; stdout: string; stderr: string }
  /** The lead proposes specialists for a job; the person hires the team once. */
  | {
      kind: 'team';
      goal: string;
      members: TeamMember[];
      status: 'open' | 'hired' | 'declined';
    }
  /** A specialist's contract: what to deliver and how code decides that it is done. */
  | {
      kind: 'contract';
      contractId: string;
      botId: string;
      botName: string;
      mission: string;
      deliverable: string;
      check: string;
      deadline: string;
      status: ContractStatus;
      evidence?: string;
    }
  | { kind: 'task'; taskId: number; title: string; owner: string | null }
  /** Know-how from GitHub: read, not run; usable once the person approved what it says. */
  | {
      kind: 'skill';
      skillId: string;
      name: string;
      description: string;
      repo: string;
      path: string;
      commit: string;
      license: string;
      stars: number;
      preview: string;
      scripts: string[];
      hosts: string[];
      flags: string[];
      alternatives: string[];
      status: 'open' | 'approved' | 'denied';
    }
  /** A file a bot made on its computer and hands over. */
  | {
      kind: 'file';
      fileId: string;
      name: string;
      sizeBytes: number;
      note?: string;
      /** The person put it here, rather than a bot. */
      fromPerson?: boolean;
    }
  /** Something a bot draws for the person, shown beside the chat. Not a checked result. */
  | {
      kind: 'visual';
      fileId: string;
      title: string;
      media: 'html' | 'image';
      version: number;
    }
  /** A library a task needs: inspected offline, installed only if the user approves. */
  | {
      kind: 'install';
      taskId: string;
      package: string;
      version: string;
      license: string;
      summary: string;
      wheels: string[];
      blocking: string[];
      test: string;
      /** From the reviewed catalog, or found by search (then nobody reviewed it beforehand). */
      source?: 'catalog' | 'search';
      /** How many names the search looked at, when it was a search. */
      considered?: number;
      /** An MCP server (tools to call) rather than a library to import. */
      mcp?: boolean;
      capabilityId?: string;
      /** Known vulnerabilities left in it: the person decides with these in front of them. */
      warnings?: string[];
      /** What inspection found worth knowing, that did not stop it. */
      flags?: string[];
      /** Keys it needs; the person types them on this card. Names only: values never come back. */
      secrets?: { name: string; description?: string }[];
      /** The only domains it may reach. */
      domains?: string[];
      /** Runs on someone else's machine: what a bot sends goes to this host. */
      hostedAt?: string;
      runtime?: 'python' | 'node' | 'remote';
      /** Other candidates that passed the same checks, best first: the person may prefer one. */
      alternatives?: string[];
      status: 'waiting' | 'approved' | 'denied';
    }
  /** A mission closed by the system, with the verdict computed from checked evidence. */
  | {
      kind: 'mission';
      missionId: string;
      goal: string;
      status: string;
      verdict: string | null;
      reportPageId: string | null;
      criteria: { field: string; expected: string; actual: unknown; status: string }[];
    }
  /** A simulation from the lab: its claims and the tables its view is drawn from. */
  | {
      kind: 'lab';
      taskId: string;
      engine: string;
      domain:
        | 'photonics'
        | 'quantum'
        | 'chemistry'
        | 'materials'
        | 'cad'
        | 'aerospace'
        | 'electronics'
        | 'mechanics'
        | 'thermal'
        | 'fluids';
      /** Downloadable results (STEP assembly, meshes). */
      files?: { id: string; name: string; sizeBytes: number }[];
      title: string;
      params: Record<string, unknown>;
      summary: Record<string, unknown>;
      artifacts: { id: string; name: string }[];
      verified: boolean | null;
    }
  /** Attached to a bot message: numbers in it that no tool result in this turn contains. */
  | { kind: 'unbacked'; numbers: string[] };

export interface ChatMessage {
  id: number;
  role: 'user' | 'bot' | 'system' | 'action' | 'card';
  botId: string | null;
  text: string;
  card: ChatCard | null;
  createdAt: string;
}

export interface BoardTask {
  id: number;
  title: string;
  ownerBot: string | null;
  status: BoardTaskStatus;
  note: string;
  updatedAt: string;
}

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string;
  botIds: string[];
  /** The bot whose own chat this is (it stays so when a team joins). */
  homeBot?: string | null;
  updatedAt: string;
  last: string;
}

export interface ChatState extends ChatSummary {
  messages: ChatMessage[];
  tasks: BoardTask[];
  /** Per bot in this chat: what it is doing now. */
  presence: Record<string, { state: Presence; activity: string }>;
  /** True while bots are taking turns in this chat. */
  running: boolean;
  /** Which brain the bots use: a model, or the built-in rules (no free conversation). */
  engine: 'model' | 'rules';
  /** The folder on the person's computer that this chat's work is copied to. */
  hostFolder: string | null;
  /** Whether this Reality can copy to folders at all. */
  folders: boolean;
}
