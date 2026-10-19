-- 0001_init.sql
-- Builds the entire schema from an empty database: citext extension, enums,
-- all domain tables with FKs/ON DELETE rules, and all indexes.

CREATE EXTENSION IF NOT EXISTS citext;

-- Enums
CREATE TYPE task_status   AS ENUM ('open', 'in_progress', 'completed');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high');
CREATE TYPE project_role  AS ENUM ('owner', 'member');

-- users
CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  email         CITEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- token_blocklist (invalidated JWTs for logout)
CREATE TABLE token_blocklist (
  jti        UUID PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX token_blocklist_expires_at_idx ON token_blocklist (expires_at);

-- projects
CREATE TABLE projects (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- project_members (M:N users <-> projects)
CREATE TABLE project_members (
  project_id BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       project_role NOT NULL DEFAULT 'member',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_id_idx    ON project_members (user_id);
CREATE INDEX project_members_project_id_idx ON project_members (project_id);

-- tasks
CREATE TABLE tasks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  status      task_status NOT NULL DEFAULT 'open',
  priority    task_priority,
  due_date    TIMESTAMPTZ,
  creator_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  assignee_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  project_id  BIGINT REFERENCES projects (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_assignee_id_idx ON tasks (assignee_id);
CREATE INDEX tasks_project_id_idx  ON tasks (project_id);
CREATE INDEX tasks_status_idx      ON tasks (status);
CREATE INDEX tasks_creator_id_idx  ON tasks (creator_id);

-- comments
CREATE TABLE comments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id    BIGINT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_task_id_idx ON comments (task_id);

-- attachments
CREATE TABLE attachments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     BIGINT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  uploader_id BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        BIGINT NOT NULL,
  path        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_task_id_idx ON attachments (task_id);

-- notifications
CREATE TABLE notifications (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_read_idx ON notifications (user_id, read);
