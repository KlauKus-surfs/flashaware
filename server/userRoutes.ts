import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  UserRecord,
} from './queries';
import { hashPassword } from './auth';
import { authenticate, requireRole, AuthRequest } from './auth';
import { logger } from './logger';

const router = Router();

// Validation schemas
const createUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().min(1, 'Name is required'),
  role: z.enum(['admin', 'operator', 'viewer']),
});

const updateUserSchema = z.object({
  email: z.string().email('Invalid email format').optional(),
  name: z.string().min(1, 'Name is required').optional(),
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
});

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
      userCount: users.length
    });
    
    res.json(sanitizedUsers);
  } catch (error) {
    logger.error('Failed to retrieve users', {
      error: (error as Error).message,
      adminId: _req.user?.id
    });
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// POST /api/users - Create new user within caller's org (admin only)
router.post('/', requireRole('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const validatedData = createUserSchema.parse(req.body);
    const orgId = getOrgId(req);
    const normalizedEmail = validatedData.email.trim().toLowerCase();
    
    // Check if user with this email already exists
    const existingUsers = await getAllUsers(orgId);
    if (existingUsers.some(u => u.email.toLowerCase() === normalizedEmail)) {
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
      newUserRole: validatedData.role
    });
    
    res.status(201).json(sanitizedUser);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: error.errors.map((e: any) => ({ field: e.path.join('.'), message: e.message }))
      });
    }
    
    logger.error('Failed to create user', {
      error: (error as Error).message,
      adminId: req.user?.id,
      requestedEmail: req.body.email
    });
    
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id - Update user (admin only, or self for limited fields)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const validatedData = updateUserSchema.parse(req.body);
    const orgId = getOrgId(req);
    
    // Check if user exists within same org
    const existingUsers = await getAllUsers(orgId);
    const targetUser = existingUsers.find(u => u.id === id);
    
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
      const hasRestrictedFields = attemptedFields.some(field => !allowedFields.includes(field));
      
      if (hasRestrictedFields || validatedData.role) {
        return res.status(403).json({ error: 'Only admins can change roles' });
      }
    }
    
    // Check email uniqueness within org if email is being changed
    if (validatedData.email && validatedData.email !== targetUser.email) {
      const emailExists = existingUsers.some(u => u.email === validatedData.email && u.id !== id);
      if (emailExists) {
        return res.status(409).json({ error: 'User with this email already exists' });
      }
    }
    
    // Hash password if provided
    const updatePayload: any = { ...validatedData };
    if (validatedData.password) {
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
      isSelfUpdate
    });
    
    res.json(sanitizedUser);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: error.errors.map((e: any) => ({ field: e.path.join('.'), message: e.message }))
      });
    }
    
    logger.error('Failed to update user', {
      error: (error as Error).message,
      requestedBy: req.user?.id,
      targetUserId: req.params.id
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
    
    // Check if user exists within same org
    const existingUsers = await getAllUsers(getOrgId(req));
    const targetUser = existingUsers.find(u => u.id === id);
    
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const success = await deleteUser(id);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete user' });
    }
    
    logger.info('Admin deleted user', {
      adminId: req.user?.id,
      deletedUserId: id,
      deletedUserEmail: targetUser.email,
      deletedUserRole: targetUser.role
    });
    
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete user', {
      error: (error as Error).message,
      adminId: req.user?.id,
      targetUserId: req.params.id
    });
    
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// GET /api/users/me - Get current user profile
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const existingUsers = await getAllUsers(getOrgId(req));
    const currentUser = existingUsers.find(u => u.id === req.user?.id);
    
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Remove password hash from response
    const { password_hash, ...sanitizedUser } = currentUser;
    
    res.json(sanitizedUser);
  } catch (error) {
    logger.error('Failed to get current user profile', {
      error: (error as Error).message,
      userId: req.user?.id
    });
    
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

export default router;
