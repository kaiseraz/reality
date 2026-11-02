import type pg from 'pg';

/**
 * Forward-only SQL migrations, applied in order inside one transaction each.
 * Never edit an applied migration; append a new one.
 */
const MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '0001_tasks_and_events',
    sql: `
      CREATE TABLE tasks (
        id          text PRIMARY KEY,
        request     text NOT NULL,
        status      text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX tasks_status_idx ON tasks (status);

      -- Append-only audit log. No UPDATE/DELETE paths exist in application code.
      CREATE TABLE events (
        id          bigserial PRIMARY KEY,
        task_id     text NOT NULL REFERENCES tasks (id),
        type        text NOT NULL,
        actor       text NOT NULL,
        payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX events_task_idx ON events (task_id, id);
    `,
  },
  {
    id: '0002_workspaces_and_artifacts',
    sql: `
      CREATE TABLE artifacts (
        id          text PRIMARY KEY,
        task_id     text NOT NULL REFERENCES tasks (id),
        sha256      text NOT NULL,
        media_type  text NOT NULL,
        filename    text NOT NULL,
        size_bytes  integer NOT NULL,
        row_count   integer NOT NULL,
        columns     jsonb NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX artifacts_task_idx ON artifacts (task_id);

      CREATE TABLE workspaces (
        id          text PRIMARY KEY,
        task_id     text NOT NULL UNIQUE REFERENCES tasks (id),
        version     integer NOT NULL,
        spec        jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Every version change is recorded with its exact inverse. Append-only, except
      -- undone_at, which marks an 'apply' entry as reverted by a later 'undo' entry.
      CREATE TABLE workspace_patches (
        workspace_id  text NOT NULL REFERENCES workspaces (id),
        version       integer NOT NULL,
        kind          text NOT NULL CHECK (kind IN ('apply', 'undo')),
        actor         text NOT NULL,
        ops           jsonb NOT NULL,
        inverse       jsonb NOT NULL,
        layout_only   boolean NOT NULL,
        undoes        integer,
        undone_at     timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, version)
      );
    `,
  },
  {
    id: '0003_runs_provenance_capabilities',
    sql: `
      -- Where an artifact came from: a user upload or a sandbox run (with its inputs).
      ALTER TABLE artifacts ADD COLUMN provenance jsonb NOT NULL DEFAULT '{"kind":"upload"}'::jsonb;

      -- Every sandbox execution, with the exact code that ran and what it produced.
      CREATE TABLE runs (
        id           text PRIMARY KEY,
        task_id      text REFERENCES tasks (id),
        step_id      text,
        kind         text NOT NULL,
        label        text NOT NULL,
        code         text NOT NULL,
        image        text NOT NULL,
        status       text NOT NULL,
        exit_code    integer,
        stdout       text NOT NULL,
        stderr       text NOT NULL,
        duration_ms  integer NOT NULL,
        inputs       jsonb NOT NULL,
        outputs      jsonb NOT NULL,
        summary      jsonb,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX runs_task_idx ON runs (task_id, created_at);

      -- Capability registry (M5). State transitions are written only by the engine.
      CREATE TABLE capabilities (
        id            text PRIMARY KEY,
        need          text NOT NULL,
        kind          text NOT NULL,
        package       text NOT NULL,
        version       text,
        state         text NOT NULL,
        license       text,
        source        jsonb NOT NULL,
        inspection    jsonb,
        tests         jsonb,
        layer_path    text,
        permissions   jsonb NOT NULL,
        limitations   jsonb NOT NULL DEFAULT '[]'::jsonb,
        uses          integer NOT NULL DEFAULT 0,
        history       jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '0004_users_and_sessions',
    sql: `
      CREATE TABLE users (
        id             text PRIMARY KEY,
        email          text NOT NULL UNIQUE,
        password_hash  text NOT NULL,
        role           text NOT NULL CHECK (role IN ('admin', 'member')),
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      -- Only a hash of the session token is stored; the token itself lives in the cookie.
      CREATE TABLE sessions (
        token_hash  text PRIMARY KEY,
        user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL
      );
      CREATE INDEX sessions_user_idx ON sessions (user_id);
      -- NULL for tasks created without accounts (AUTH=off); those are visible to admins.
      ALTER TABLE tasks ADD COLUMN owner_id text REFERENCES users (id);
      CREATE INDEX tasks_owner_idx ON tasks (owner_id, created_at);
    `,
  },
  {
    id: '0005_projects',
    sql: `
      CREATE TABLE projects (
        id                   text PRIMARY KEY,
        owner_id             text REFERENCES users (id),
        goal                 text NOT NULL,
        status               text NOT NULL,
        autonomy             text NOT NULL,
        max_parallel         integer NOT NULL,
        max_tasks            integer NOT NULL,
        max_sandbox_minutes  integer NOT NULL,
        planner              text NOT NULL,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX projects_owner_idx ON projects (owner_id, created_at);
      CREATE INDEX projects_status_idx ON projects (status);

      -- Each project task is an ordinary task; this row adds its place in the project.
      CREATE TABLE project_tasks (
        task_id     text PRIMARY KEY REFERENCES tasks (id),
        project_id  text NOT NULL REFERENCES projects (id),
        position    integer NOT NULL,
        title       text NOT NULL,
        depends_on  jsonb NOT NULL DEFAULT '[]'::jsonb,
        input_from  text REFERENCES tasks (id),
        -- Set before inputs are attached, so a restart never attaches them twice.
        started_at  timestamptz
      );
      CREATE INDEX project_tasks_project_idx ON project_tasks (project_id, position);

      -- Data every task of the project receives (stored as files under ARTIFACT_DIR).
      CREATE TABLE project_files (
        id          text PRIMARY KEY,
        project_id  text NOT NULL REFERENCES projects (id),
        filename    text NOT NULL,
        path        text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Append-only project log (scheduling, policy decisions, budget).
      CREATE TABLE project_events (
        id          bigserial PRIMARY KEY,
        project_id  text NOT NULL REFERENCES projects (id),
        type        text NOT NULL,
        actor       text NOT NULL,
        payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX project_events_project_idx ON project_events (project_id, id);
    `,
  },
  {
    id: '0006_task_criteria',
    sql: `
      -- Success criteria set by a person; kept apart from the plan so no planner changes them.
      CREATE TABLE task_criteria (
        task_id    text NOT NULL REFERENCES tasks (id),
        id         text NOT NULL,
        position   integer NOT NULL,
        criterion  jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (task_id, id)
      );
    `,
  },
  {
    id: '0007_bots',
    sql: `
      CREATE TABLE bots (
        id          text PRIMARY KEY,
        owner_id    text REFERENCES users (id),
        name        text NOT NULL,
        role        text NOT NULL,
        color       text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX bots_owner_idx ON bots (owner_id, created_at);
      ALTER TABLE tasks ADD COLUMN bot_id text REFERENCES bots (id) ON DELETE SET NULL;
      CREATE INDEX tasks_bot_idx ON tasks (bot_id, status);
      ALTER TABLE projects ADD COLUMN team jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    id: '0008_knowledge',
    sql: `
      -- A person's own sources (notes, web pages, text files), split into passages for BM25.
      CREATE TABLE knowledge_sources (
        id          text PRIMARY KEY,
        owner_id    text REFERENCES users (id),
        kind        text NOT NULL CHECK (kind IN ('note', 'url', 'file')),
        name        text NOT NULL,
        url         text,
        status      text NOT NULL,
        error       text,
        passages    integer NOT NULL DEFAULT 0,
        words       integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX knowledge_sources_owner_idx ON knowledge_sources (owner_id, created_at);
      CREATE TABLE knowledge_passages (
        source_id  text NOT NULL REFERENCES knowledge_sources (id) ON DELETE CASCADE,
        position   integer NOT NULL,
        line       integer NOT NULL,
        text       text NOT NULL,
        terms      jsonb NOT NULL,
        length     integer NOT NULL,
        PRIMARY KEY (source_id, position)
      );
    `,
  },
  {
    id: '0009_pages_routines',
    sql: `
      -- Pages: documents people and bots write together. Every change is a new version,
      -- so nothing is lost and anything can be taken back, also at night when nobody approves.
      CREATE TABLE pages (
        id          text PRIMARY KEY,
        owner_id    text REFERENCES users (id),
        title       text NOT NULL,
        version     integer NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX pages_owner_idx ON pages (owner_id, updated_at);
      CREATE TABLE page_versions (
        page_id     text NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
        version     integer NOT NULL,
        content     text NOT NULL,
        author      text NOT NULL,
        change      text NOT NULL,
        task_id     text REFERENCES tasks (id) ON DELETE SET NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (page_id, version)
      );
      -- Routines: a task that starts itself on a schedule.
      CREATE TABLE routines (
        id            text PRIMARY KEY,
        owner_id      text REFERENCES users (id),
        name          text NOT NULL,
        request       text NOT NULL,
        schedule      jsonb NOT NULL,
        sample        text,
        bot_id        text REFERENCES bots (id) ON DELETE SET NULL,
        page_id       text REFERENCES pages (id) ON DELETE SET NULL,
        auto_approve  boolean NOT NULL DEFAULT false,
        enabled       boolean NOT NULL DEFAULT true,
        next_run      timestamptz,
        last_run      timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE routine_runs (
        routine_id  text NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
        task_id     text NOT NULL REFERENCES tasks (id),
        started_at  timestamptz NOT NULL DEFAULT now(),
        -- approved | deferred | published | finished: what the scheduler already did
        handled     text,
        note        text,
        PRIMARY KEY (routine_id, task_id)
      );
    `,
  },
  {
    id: '0010_chats',
    sql: `
      -- Bots as colleagues you talk to: direct and group chats, a task board per chat,
      -- and what each bot remembers.
      ALTER TABLE bots ADD COLUMN persona text NOT NULL DEFAULT '';
      ALTER TABLE bots ADD COLUMN figure text NOT NULL DEFAULT 'orb';
      CREATE TABLE chats (
        id          text PRIMARY KEY,
        owner_id    text REFERENCES users (id),
        kind        text NOT NULL CHECK (kind IN ('dm', 'group')),
        title       text NOT NULL,
        bot_ids     jsonb NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX chats_owner_idx ON chats (owner_id, updated_at);
      CREATE TABLE chat_messages (
        id          bigserial PRIMARY KEY,
        chat_id     text NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
        role        text NOT NULL CHECK (role IN ('user', 'bot', 'system', 'action', 'card')),
        bot_id      text REFERENCES bots (id) ON DELETE SET NULL,
        text        text NOT NULL DEFAULT '',
        card        jsonb,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX chat_messages_chat_idx ON chat_messages (chat_id, id);
      CREATE TABLE chat_tasks (
        chat_id     text NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
        id          integer NOT NULL,
        title       text NOT NULL,
        owner_bot   text REFERENCES bots (id) ON DELETE SET NULL,
        status      text NOT NULL CHECK (status IN ('open', 'doing', 'waiting', 'done')),
        note        text NOT NULL DEFAULT '',
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (chat_id, id)
      );
      -- Reality tasks a bot started from a chat; the engine reports back when they move.
      CREATE TABLE chat_runs (
        chat_id     text NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
        task_id     text NOT NULL REFERENCES tasks (id),
        bot_id      text REFERENCES bots (id) ON DELETE SET NULL,
        reported    text,
        PRIMARY KEY (chat_id, task_id)
      );
      CREATE TABLE bot_memory (
        id          bigserial PRIMARY KEY,
        bot_id      text NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
        text        text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '0011_task_presets',
    sql: `
      -- Lab simulations started by a bot: their plan is fixed, not left to a planner.
      CREATE TABLE task_presets (
        task_id   text PRIMARY KEY REFERENCES tasks (id),
        engine    text NOT NULL,
        params    jsonb NOT NULL
      );
    `,
  },
  {
    id: '0012_missions',
    sql: `
      -- Research missions: a goal with criteria and a budget that a team works on in a chat,
      -- also overnight. The verdict is computed by code from verified evidence.
      CREATE TABLE missions (
        id             text PRIMARY KEY,
        owner_id       text REFERENCES users (id),
        chat_id        text NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
        goal           text NOT NULL,
        criteria       jsonb NOT NULL,
        hours          numeric NOT NULL,
        max_tasks      integer NOT NULL,
        auto_approve   boolean NOT NULL,
        status         text NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'stopped', 'timeout')),
        verdict        text,
        summary        text,
        report_page_id text REFERENCES pages (id) ON DELETE SET NULL,
        started_at     timestamptz NOT NULL DEFAULT now(),
        ends_at        timestamptz NOT NULL,
        finished_at    timestamptz
      );
      CREATE INDEX missions_owner_idx ON missions (owner_id, started_at);
      CREATE TABLE mission_journal (
        id          bigserial PRIMARY KEY,
        mission_id  text NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
        text        text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '0013_task_files',
    sql: `
      -- Binary step results that are not tables: CAD assemblies (STEP), meshes (STL).
      CREATE TABLE task_files (
        id          text PRIMARY KEY,
        task_id     text NOT NULL REFERENCES tasks (id),
        step_id     text,
        name        text NOT NULL,
        media_type  text NOT NULL,
        size_bytes  bigint NOT NULL,
        sha256      text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX task_files_task_idx ON task_files (task_id, step_id);
    `,
  },
  {
    id: '0014_bot_computers',
    sql: `
      -- Domains a bot's computer may reach, granted by a person. Revoking deletes the row;
      -- the decision itself stays in bot_computer_log.
      CREATE TABLE bot_computer_access (
        bot_id      text NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
        domain      text NOT NULL,
        granted_by  text,
        granted_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (bot_id, domain)
      );
      -- What happened on a bot's computer: commands, files, pages, network decisions.
      CREATE TABLE bot_computer_log (
        id          bigserial PRIMARY KEY,
        bot_id      text NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
        kind        text NOT NULL,
        summary     text NOT NULL,
        detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX bot_computer_log_bot_idx ON bot_computer_log (bot_id, id);
    `,
  },
  {
    id: '0015_team_lead_contracts_skills',
    sql: `
      -- The lead every person has, and specialists resting between jobs.
      ALTER TABLE bots ADD COLUMN is_main boolean NOT NULL DEFAULT false;
      ALTER TABLE bots ADD COLUMN resting boolean NOT NULL DEFAULT false;
      ALTER TABLE bots ADD COLUMN hired_by text;

      -- A specialist's job: what to deliver, how code checks it, and the time it has.
      CREATE TABLE bot_contracts (
        id              text PRIMARY KEY,
        chat_id         text NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
        bot_id          text NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
        mission         text NOT NULL,
        deliverable     text NOT NULL,
        check_spec      jsonb NOT NULL,
        deadline        timestamptz NOT NULL,
        status          text NOT NULL CHECK (status IN ('active', 'review', 'met', 'failed', 'released')),
        evidence        text NOT NULL DEFAULT '',
        card_message_id bigint,
        board_task_id   integer,
        created_at      timestamptz NOT NULL DEFAULT now(),
        closed_at       timestamptz
      );
      CREATE INDEX bot_contracts_bot_idx ON bot_contracts (bot_id, status);
      CREATE INDEX bot_contracts_chat_idx ON bot_contracts (chat_id, status);

      -- Scripts a bot saved after solving something, reusable by the whole team.
      CREATE TABLE bot_skills (
        id          text PRIMARY KEY,
        owner_id    text REFERENCES users (id) ON DELETE CASCADE,
        name        text NOT NULL,
        description text NOT NULL,
        filename    text NOT NULL,
        code        text NOT NULL,
        created_by  text REFERENCES bots (id) ON DELETE SET NULL,
        uses        integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX bot_skills_name_idx ON bot_skills (COALESCE(owner_id, ''), name);
    `,
  },
  {
    id: '0016_chat_home_bot',
    sql: `
      -- A bot's own chat stays its own when a team joins it (the lead's chat becomes a group).
      ALTER TABLE chats ADD COLUMN home_bot text;
      UPDATE chats SET home_bot = bot_ids->>0 WHERE kind = 'dm';
      CREATE INDEX chats_home_bot_idx ON chats (home_bot);
    `,
  },
  {
    id: '0017_overnight_missions',
    sql: `
      -- Every model call and what it cost, for the chat, bot or task it was made for.
      CREATE TABLE model_usage (
        id             bigserial PRIMARY KEY,
        chat_id        text,
        bot_id         text,
        task_id        text,
        model          text NOT NULL,
        input_tokens   integer NOT NULL,
        output_tokens  integer NOT NULL,
        cost           numeric NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX model_usage_chat_idx ON model_usage (chat_id);
      CREATE INDEX model_usage_task_idx ON model_usage (task_id);

      -- Overnight missions: a cost budget, what may happen without asking, rounds of work.
      ALTER TABLE missions ADD COLUMN cost_budget numeric;
      ALTER TABLE missions ADD COLUMN allow_installs jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE missions ADD COLUMN allow_domains jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE missions ADD COLUMN warned boolean NOT NULL DEFAULT false;
      ALTER TABLE missions ADD COLUMN rounds integer NOT NULL DEFAULT 0;
      ALTER TABLE missions ADD COLUMN max_rounds integer NOT NULL DEFAULT 12;
      ALTER TABLE missions DROP CONSTRAINT missions_status_check;
      ALTER TABLE missions ADD CONSTRAINT missions_status_check
        CHECK (status IN ('running', 'finished', 'failed', 'stopped', 'timeout', 'out_of_budget'));
    `,
  },
  {
    id: '0018_memory_per_chat',
    sql: `
      -- A bot's memory belongs to the chat it was learned in, so an old job's
      -- facts stop leaking into new conversations. Existing rows keep no chat:
      -- they stay in the database but are no longer read.
      ALTER TABLE bot_memory ADD COLUMN chat_id text REFERENCES chats (id) ON DELETE CASCADE;
      CREATE INDEX bot_memory_bot_chat_idx ON bot_memory (bot_id, chat_id, id);
    `,
  },
  {
    id: '0019_capability_secrets',
    sql: `
      -- API keys a person gave a tool server. Encrypted; no API returns a value.
      CREATE TABLE capability_secrets (
        capability_id text NOT NULL,
        name          text NOT NULL,
        owner_id      text,
        value         text NOT NULL,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (capability_id, name)
      );
    `,
  },
  {
    id: '0020_files_without_a_task',
    sql: `
      -- A file a bot hands the person from its computer belongs to the chat, not to a task.
      ALTER TABLE task_files ALTER COLUMN task_id DROP NOT NULL;
    `,
  },
  {
    id: '0021_agent_skills',
    sql: `
      -- Skills from GitHub, pinned to a commit, usable once a person approved them.
      CREATE TABLE agent_skills (
        id          text PRIMARY KEY,
        owner_id    text,
        name        text NOT NULL,
        description text NOT NULL,
        repo        text NOT NULL,
        path        text NOT NULL,
        commit_sha  text NOT NULL,
        license     text NOT NULL,
        stars       integer NOT NULL,
        body        text NOT NULL,
        files       jsonb NOT NULL,
        scan        jsonb NOT NULL,
        state       text NOT NULL DEFAULT 'proposed',
        uses        integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '0022_file_owners',
    sql: `
      -- Files people put into a chat, and what tools made for them, are theirs.
      ALTER TABLE task_files ADD COLUMN owner_id text;
    `,
  },
  {
    id: '0023_chat_folders',
    sql: `
      -- The folder on the person's own computer that a chat's work is copied to.
      ALTER TABLE chats ADD COLUMN host_folder text;
    `,
  },
];

export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const applied = new Set(
    (await pool.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id),
  );
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      await client.query('COMMIT');
      ran.push(m.id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${m.id} failed`, { cause: err });
    } finally {
      client.release();
    }
  }
  return ran;
}
