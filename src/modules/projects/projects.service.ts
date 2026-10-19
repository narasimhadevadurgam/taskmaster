import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import type { Paginated } from '../shared/pagination.js';
import type { AddMemberInput, CreateProjectInput } from './projects.schemas.js';

/** Canonical project row (no joined names). */
export interface Project {
  id: number;
  name: string;
  description: string | null;
  owner_id: number;
  created_at: Date;
}

/** A project list row includes the caller's own role in that project. */
export interface ProjectListRow extends Project {
  role: 'owner' | 'member';
}

/** A membership row as returned by POST /projects/:id/members. */
export interface Member {
  project_id: number;
  user_id: number;
  role: 'owner' | 'member';
  joined_at: Date;
}

/** A member of a project joined to the user for GET /projects/:id. */
export interface ProjectMemberDetail {
  user_id: number;
  name: string;
  email: string;
  role: 'owner' | 'member';
  joined_at: Date;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Return true if the user is a member (owner or member) of the project. Shared
 * by task authorization. Accepts an optional client so it can run inside a
 * transaction.
 */
export async function isProjectMember(
  projectId: number,
  userId: number,
  client?: PoolClient
): Promise<boolean> {
  const run = client
    ? client.query.bind(client)
    : (text: string, params: unknown[]) => query(text, params);
  const result = await run(
    'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Create a project with owner_id = creatorId and insert the owner's
 * project_members row in the same transaction.
 */
export async function createProject(
  creatorId: number,
  input: CreateProjectInput
): Promise<Project> {
  return withTransaction(async (client) => {
    const projectResult = await client.query<Project>(
      `INSERT INTO projects (name, description, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, owner_id, created_at`,
      [input.name, input.description ?? null, creatorId]
    );
    const project = projectResult.rows[0];
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [project.id, creatorId]
    );
    return project;
  });
}

/**
 * Add a member to a project. Owner-only (else 403); project not visible to the
 * caller or target user missing -> 404; already a member -> 409 CONFLICT.
 */
export async function addMember(
  projectId: number,
  callerId: number,
  input: AddMemberInput
): Promise<Member> {
  // Load the project and the caller's membership to decide visibility/role.
  const projectResult = await query<{ owner_id: number }>(
    'SELECT owner_id FROM projects WHERE id = $1',
    [projectId]
  );
  const project = projectResult.rows[0];
  if (!project) {
    throw new AppError('NOT_FOUND', 'Project not found');
  }

  const callerIsMember = await isProjectMember(projectId, callerId);
  // A caller who is not a member cannot see the project at all -> 404.
  if (!callerIsMember) {
    throw new AppError('NOT_FOUND', 'Project not found');
  }
  // A member who is not the owner can see it but may not add members -> 403.
  if (project.owner_id !== callerId) {
    throw new AppError('FORBIDDEN', 'Only the project owner can add members');
  }

  // Resolve the target user by id or email.
  let targetUserId: number | undefined;
  if (input.user_id != null) {
    const userResult = await query<{ id: number }>('SELECT id FROM users WHERE id = $1', [
      input.user_id,
    ]);
    targetUserId = userResult.rows[0]?.id;
  } else {
    const userResult = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [
      input.email?.toLowerCase(),
    ]);
    targetUserId = userResult.rows[0]?.id;
  }
  if (targetUserId == null) {
    throw new AppError('NOT_FOUND', 'User not found');
  }

  try {
    const result = await query<Member>(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'member')
       RETURNING project_id, user_id, role, joined_at`,
      [projectId, targetUserId]
    );
    return result.rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('CONFLICT', 'User is already a member of this project');
    }
    throw err;
  }
}

/**
 * List projects the caller owns or belongs to, paginated. Deterministic order
 * `created_at DESC, id DESC`. COUNT(*) uses the SAME membership predicate.
 */
export async function listProjects(
  callerId: number,
  limit: number,
  offset: number
): Promise<Paginated<ProjectListRow>> {
  // Base membership predicate reused by the data query and the COUNT(*).
  const from = `
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1`;

  const dataResult = await query<ProjectListRow>(
    `SELECT p.id, p.name, p.description, p.owner_id, p.created_at, pm.role
     ${from}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $2 OFFSET $3`,
    [callerId, limit, offset]
  );
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*)::bigint AS count ${from}`,
    [callerId]
  );
  const total = countResult.rows[0]?.count ?? 0;

  return { data: dataResult.rows, pagination: { limit, offset, total } };
}

/**
 * Fetch a single project with its members. Member-only (else 404). Members are
 * ordered owner-first, then joined_at ASC, user_id ASC.
 */
export async function getProject(
  projectId: number,
  callerId: number
): Promise<{ project: Project; members: ProjectMemberDetail[] }> {
  const callerIsMember = await isProjectMember(projectId, callerId);
  if (!callerIsMember) {
    throw new AppError('NOT_FOUND', 'Project not found');
  }

  const projectResult = await query<Project>(
    'SELECT id, name, description, owner_id, created_at FROM projects WHERE id = $1',
    [projectId]
  );
  const project = projectResult.rows[0];
  if (!project) {
    throw new AppError('NOT_FOUND', 'Project not found');
  }

  const membersResult = await query<ProjectMemberDetail>(
    `SELECT pm.user_id, u.name, u.email, pm.role, pm.joined_at
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1
     ORDER BY (pm.role = 'owner') DESC, pm.joined_at ASC, pm.user_id ASC`,
    [projectId]
  );

  return { project, members: membersResult.rows };
}
