import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getAllUsers, createUser, updateUser, deleteUser, UserRecord } from './queries';
import { hashPassword, invalidateAuthCache, isBannedPassword } from './auth';
import { authenticate, requireRole, AuthRequest } from './auth';
import { getOne } from './db';
import { logger } from './logger';
import { logAudit } from './audit';

const router = Router();

// Validation schemas
const createUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().min(1, 'Name is required'),
  role: z.enum(['admin', 'operator', 'viewer']),
});

// .strict() rejects unknown body fields with a 400 instead of silently dropping
// them. Belt-and-braces against a future field accidentally being routed into
// updateUser() (e.g. body.org_id, body.role bypassing the admin gate via a
// payload-shape change). The handler still has its own non-admin field
// whitelist, but locking the input contract here means the handler can't be
// fooled by a key it didn't expect.
const updateUserSchema = z
  .object({
    email: z.string().email('Invalid email format').optional(),
    name: z.string().min(1, 'Name is required').optional(),
    role: z.enum(['admin', 'operator', 'viewer']).optional(),
    password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  })
  .strict();

function getOrgId(req: AuthRequest): string {
  return req.user!.org_id;
}

function isAdminOrAbove(req: AuthRequest): boolean {
  return req.user?.role === 'admin' || req.user?.role === 'super_admin';
}

// Apply authentication to all user routes
router.use(authenticate);

// GET /api/users - List all users within the caller's org (admin only)
router.get('/', requireRole('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const users = await getAllUsers(getOrgId(_req));

    // Remove password hashes from response
    const sanitizedUsers = users.map(({ password_hash, ...user }) => user);

    logger.info('Admin retrieved user list', {
      adminId: _req.user?.id,
      userCount: users.length,
    });

    res.json(sanitizedUsers);
  } catch (error) {
    logger.error('Failed to retrieve users', {
      error: (error as Error).message,
      adminId: _req.user?.id,
    });
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// POST /api/users - Create new user (super_admin can specify org_id; admin creates in own org)
router.post('/', requireRole('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const validatedData = createUserSchema.parse(req.body);
    if (isBannedPassword(validatedData.password)) {
      return res.status(400).json({
        error: 'That password is on the well-known-default block list. Pick something unique.',
      });
    }
    const isSuperAdmin = req.user?.role === 'super_admin';
    const orgId = isSuperAdmin && req.body.org_id ? req.body.org_id : getOrgId(req);
    const normalizedEmail = validatedData.email.trim().toLowerCase();

    // users.email has a global UNIQUE constraint (db/schema.sql:32), so the
    // collision check has to be global too — otherwise an email already taken
    // in another org would slip past this check and trip the DB constraint as
    // a 500. Lookup by lowercased email keeps the check case-insensitive.
    const conflict = await getOne<{ id: string }>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [normalizedEmail],
    );
    if (conflict) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const newUser = await createUser({
      email: normalizedEmail,
      password: validatedData.password,
      name: validatedData.name,
      role: validatedData.role,
      org_id: orgId,
    });

    // Remove password hash from response
    const { password_hash, ...sanitizedUser } = newUser;

    logger.info('Admin created new user', {
      adminId: req.user?.id,
      newUserId: newUser.id,
      newUserEmail: normalizedEmail,
      newUserRole: validatedData.role,
    });
    await logAudit({
      req,
      action: 'user.create',
      target_type: 'user',
      target_id: newUser.id,
      target_org_id: orgId,
      after: { email: normalizedEmail, role: validatedData.role, name: validatedData.name },
    });

    res.status(201).json(sanitizedUser);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors.map((e: any) => ({ field: e.path.join('.'), message: e.message })),
      });
    }

    logger.error('Failed to create user', {
      error: (error as Error).message,
      adminId: req.user?.id,
      requestedEmail: req.body.email,
    });

    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id - Update user (admin only, or self for limited fields)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const validatedData = updateUserSchema.parse(req.body);
    const isSuperAdmin = req.user?.role === 'super_admin';
    const orgId = getOrgId(req);

    // super_admin can edit any user; admin is scoped to own org
    let targetUser: UserRecord | undefined;
    if (isSuperAdmin) {
      const found = await getOne<UserRecord>('SELECT * FROM users WHERE id = $1', [id]);
      targetUser = found ?? undefined;
    } else {
      const existingUsers = await getAllUsers(orgId);
      targetUser = existingUsers.find((u) => u.id === id);
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check permissions: admin can update anyone in org, users can only update themselves
    const isSelfUpdate = req.user?.id === id;
    const isAdmin = isAdminOrAbove(req);

    if (!isAdmin && !isSelfUpdate) {
      return res.status(403).json({ error: 'You can only update your own profile' });
    }

    // Non-admin users can only update their name and email
    if (!isAdmin) {
      const allowedFields = ['email', 'name'];
      const attemptedFields = Object.keys(validatedData);
      const hasRestrictedFields = attemptedFields.some((field) => !allowedFields.includes(field));

      if (hasRestrictedFields || validatedData.role) {
        return res.status(403).json({ error: 'Only admins can change roles' });
      }
    }

    // Email is globally UNIQUE on users — check across orgs, not just this one,
    // so the user gets a clean 409 instead of a 500 from the DB constraint.
    if (
      validatedData.email &&
      validatedData.email.toLowerCase() !== targetUser.email.toLowerCase()
    ) {
      const conflict = await getOne<{ id: string }>(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1',
        [validatedData.email, id],
      );
      if (conflict) {
        return res.status(409).json({ error: 'User with this email already exists' });
      }
    }

    // Hash password if provided
    const updatePayload: any = { ...validatedData };
    if (validatedData.password) {
      if (isBannedPassword(validatedData.password)) {
        return res.status(400).json({
          error: 'That password is on the well-known-default block list. Pick something unique.',
        });
      }
      updatePayload.password = await hashPassword(validatedData.password);
    }

    const updatedUser = await updateUser(id, updatePayload);

    if (!updatedUser) {
      return res.status(500).json({ error: 'Failed to update user' });
    }

    // Remove password hash from response
    const { password_hash, ...sanitizedUser } = updatedUser;

    logger.info('User updated', {
      updatedUserId: id,
      updatedBy: req.user?.id,
      updatedByRole: req.user?.role,
      fields: Object.keys(validatedData),
      isSelfUpdate,
    });
    const auditAfter: Record<string, unknown> = {};
    for (const k of Object.keys(validatedData)) {
      // never write the new password into audit; record presence only
      auditAfter[k] = k === 'password' ? '[changed]' : (validatedData as any)[k];
    }
    await logAudit({
      req,
      action: 'user.update',
      target_type: 'user',
      target_id: id,
      target_org_id: targetUser.org_id ?? null,
      before: { email: targetUser.email, name: targetUser.name, role: targetUser.role },
      after: auditAfter,
    });

    res.json(sanitizedUser);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors.map((e: any) => ({ field: e.path.join('.'), message: e.message })),
      });
    }

    logger.error('Failed to update user', {
      error: (error as Error).message,
      requestedBy: req.user?.id,
      targetUserId: req.params.id,
    });

    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id - Delete user (admin only)
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Prevent self-deletion
    if (req.user?.id === id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // super_admin can delete any user; admin is scoped to own org
    const isSuperAdmin = req.user?.role === 'super_admin';
    let targetUser: UserRecord | undefined;
    if (isSuperAdmin) {
      const found = await getOne<UserRecord>('SELECT * FROM users WHERE id = $1', [id]);
      targetUser = found ?? undefined;
    } else {
      const existingUsers = await getAllUsers(getOrgId(req));
      targetUser = existingUsers.find((u) => u.id === id);
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { deleted, recipientsRemoved } = await deleteUser(id);

    if (!deleted) {
      return res.status(500).json({ error: 'Failed to delete user' });
    }

    // Drop any cached auth-recheck entry for this user so a still-live JWT
    // is rejected on the very next request (without waiting out the TTL).
    invalidateAuthCache(id);

    logger.info('Admin deleted user', {
      adminId: req.user?.id,
      deletedUserId: id,
      deletedUserEmail: targetUser.email,
      deletedUserRole: targetUser.role,
      recipientsRemoved,
    });
    await logAudit({
      req,
      action: 'user.delete',
      target_type: 'user',
      target_id: id,
      target_org_id: targetUser.org_id ?? null,
      before: { email: targetUser.email, role: targetUser.role, name: targetUser.name },
      after: { recipients_removed: recipientsRemoved },
    });

    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete user', {
      error: (error as Error).message,
      adminId: req.user?.id,
      targetUserId: req.params.id,
    });

    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// POST /api/users/:id/reset-password - Reset another user's password (admin only)
router.post(
  '/:id/reset-password',
  requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { password } = req.body;

      if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      if (isBannedPassword(password)) {
        return res.status(400).json({
          error: 'That password is on the well-known-default block list. Pick something unique.',
        });
      }

      // Prevent resetting your own password through this endpoint (use profile update instead)
      if (req.user?.id === id) {
        return res
          .status(400)
          .json({ error: 'Use the profile update endpoint to change your own password' });
      }

      // super_admin can reset any user's password; admin is scoped to own org
      const isSuperAdmin = req.user?.role === 'super_admin';
      let targetUser: UserRecord | undefined;
      if (isSuperAdmin) {
        const found = await getOne<UserRecord>('SELECT * FROM users WHERE id = $1', [id]);
        targetUser = found ?? undefined;
      } else {
        const existingUsers = await getAllUsers(getOrgId(req));
        targetUser = existingUsers.find((u) => u.id === id);
      }
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      const hashed = await hashPassword(password);
      const updated = await updateUser(id, { password: hashed });
      if (!updated) {
        return res.status(500).json({ error: 'Failed to reset password' });
      }

      logger.info('Admin reset user password', {
        adminId: req.user?.id,
        targetUserId: id,
        targetUserEmail: targetUser.email,
      });
      await logAudit({
        req,
        action: 'user.password_reset',
        target_type: 'user',
        target_id: id,
        target_org_id: targetUser.org_id ?? null,
      });

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      logger.error('Failed to reset user password', {
        error: (error as Error).message,
        adminId: req.user?.id,
        targetUserId: req.params.id,
      });
      res.status(500).json({ error: 'Failed to reset password' });
    }
  },
);

// GET /api/users/me - Get current user profile
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const existingUsers = await getAllUsers(getOrgId(req));
    const currentUser = existingUsers.find((u) => u.id === req.user?.id);

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Remove password hash from response
    const { password_hash, ...sanitizedUser } = currentUser;

    res.json(sanitizedUser);
  } catch (error) {
    logger.error('Failed to get current user profile', {
      error: (error as Error).message,
      userId: req.user?.id,
    });

    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

export default router;
