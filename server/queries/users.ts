import { query, getOne, getMany } from '../db';
import bcrypt from 'bcrypt';

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'super_admin' | 'admin' | 'operator' | 'viewer';
  org_id: string;
  created_at: string;
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  return getOne<UserRecord>(
    'SELECT id, email, password AS password_hash, name, role, org_id, created_at FROM users WHERE email = $1',
    [email],
  );
}

export async function createUser(userData: {
  email: string;
  password: string;
  name: string;
  role: 'super_admin' | 'admin' | 'operator' | 'viewer';
  org_id: string;
}): Promise<UserRecord> {
  const passwordHash = await bcrypt.hash(userData.password, 10);
  const result = await getOne<UserRecord>(
    `INSERT INTO users (email, password, name, role, org_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, password AS password_hash, name, role, org_id, created_at`,
    [userData.email, passwordHash, userData.name, userData.role, userData.org_id],
  );
  if (!result) throw new Error('Failed to create user');
  return result;
}

export async function updateUser(
  id: string,
  updates: Partial<{
    email: string;
    name: string;
    role: 'super_admin' | 'admin' | 'operator' | 'viewer';
    password: string;
  }>,
): Promise<UserRecord | null> {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (updates.email) {
    fields.push(`email = $${paramIndex++}`);
    values.push(updates.email);
  }
  if (updates.name) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.role) {
    fields.push(`role = $${paramIndex++}`);
    values.push(updates.role);
  }
  if (updates.password) {
    fields.push(`password = $${paramIndex++}`);
    values.push(updates.password);
  }

  if (fields.length === 0) return null;

  values.push(id);
  const result = await getOne<UserRecord>(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  return result;
}

/**
 * Delete a user and unsubscribe them from every per-location notification
 * within their org. `location_recipients` stores plain email/phone strings —
 * there is no FK back to `users` — so without this cleanup the alert
 * dispatcher would keep emailing/SMSing/WhatsApp-ing a removed user. Match is
 * case-insensitive on email; org_id-scoped so a same-named user in another
 * tenant is unaffected.
 */
export async function deleteUser(
  id: string,
): Promise<{ deleted: boolean; recipientsRemoved: number }> {
  const u = await getOne<{ email: string; org_id: string }>(
    'SELECT email, org_id FROM users WHERE id = $1',
    [id],
  );
  if (!u) return { deleted: false, recipientsRemoved: 0 };

  const recipResult = await query(
    `DELETE FROM location_recipients
       WHERE LOWER(email) = LOWER($1)
         AND location_id IN (SELECT id FROM locations WHERE org_id = $2)`,
    [u.email, u.org_id],
  );

  const result = await query('DELETE FROM users WHERE id = $1', [id]);
  return {
    deleted: (result.rowCount ?? 0) > 0,
    recipientsRemoved: recipResult.rowCount ?? 0,
  };
}

export async function getAllUsers(orgId: string): Promise<UserRecord[]> {
  return getMany<UserRecord>(
    'SELECT id, email, password AS password_hash, name, role, org_id, created_at FROM users WHERE org_id = $1 ORDER BY created_at DESC',
    [orgId],
  );
}
