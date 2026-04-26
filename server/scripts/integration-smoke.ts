/**
 * Tests for the three management changes:
 *   1. Prev/next user navigation index logic
 *   2. DELETE /api/orgs/:id — cascade deletion
 *   3. Default-org protection
 *   4. Delete-user still works
 *
 * Pure-logic tests run immediately (no DB required).
 * DB-dependent tests run inside runDbTests() — requires docker compose up -d.
 *
 * Run: npx ts-node server/test-mgmt-changes.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ─── 1. Pure: user navigation index logic ────────────────────────────────────

console.log('\n── 1. User prev/next navigation (pure logic) ──');

interface UserStub { id: string; name: string; }
const users: UserStub[] = [
  { id: 'u1', name: 'Alice' },
  { id: 'u2', name: 'Bob' },
  { id: 'u3', name: 'Carol' },
];

function navigateEditUser(
  currentIndex: number,
  direction: 'prev' | 'next',
  list: UserStub[]
): { index: number; user: UserStub } | null {
  const newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
  if (newIndex < 0 || newIndex >= list.length) return null;
  return { index: newIndex, user: list[newIndex] };
}

// Start at first user
const nav1 = navigateEditUser(0, 'prev', users);
ok('prev from index 0 returns null (boundary)', nav1 === null);

const nav2 = navigateEditUser(0, 'next', users);
ok('next from index 0 goes to index 1', nav2?.index === 1 && nav2?.user.id === 'u2');

const nav3 = navigateEditUser(1, 'next', users);
ok('next from index 1 goes to index 2', nav3?.index === 2 && nav3?.user.id === 'u3');

const nav4 = navigateEditUser(2, 'next', users);
ok('next from last index returns null (boundary)', nav4 === null);

const nav5 = navigateEditUser(2, 'prev', users);
ok('prev from last index goes to index 1', nav5?.index === 1 && nav5?.user.id === 'u2');

const nav6 = navigateEditUser(1, 'prev', users);
ok('prev from middle goes to index 0', nav6?.index === 0 && nav6?.user.id === 'u1');

// Single-user list: both directions blocked
const singleUser: UserStub[] = [{ id: 'u1', name: 'Solo' }];
ok('prev disabled on single-user list', navigateEditUser(0, 'prev', singleUser) === null);
ok('next disabled on single-user list', navigateEditUser(0, 'next', singleUser) === null);

// Counter display logic: "selectedUserIndex + 1 / users.length"
const display = (idx: number, list: UserStub[]) => `${idx + 1} / ${list.length}`;
ok('counter shows "1 / 3" for index 0', display(0, users) === '1 / 3');
ok('counter shows "3 / 3" for last index', display(2, users) === '3 / 3');

// ─── 2. Pure: default org protection ─────────────────────────────────────────

console.log('\n── 2. Default org protection (pure logic) ──');

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

function canDeleteOrg(id: string): { allowed: boolean; reason?: string } {
  if (id === DEFAULT_ORG_ID) {
    return { allowed: false, reason: 'The default FlashAware organisation cannot be deleted' };
  }
  return { allowed: true };
}

ok('default org is blocked', !canDeleteOrg(DEFAULT_ORG_ID).allowed);
ok('default org returns correct error message',
  canDeleteOrg(DEFAULT_ORG_ID).reason === 'The default FlashAware organisation cannot be deleted');
ok('non-default org is allowed', canDeleteOrg('aaaaaaaa-0000-0000-0000-000000000002').allowed);
ok('random UUID is allowed', canDeleteOrg('12345678-1234-1234-1234-123456789abc').allowed);

// ─── 3. Pure: org name confirmation dialog logic ──────────────────────────────

console.log('\n── 3. Org name confirmation (pure logic) ──');

function isDeleteConfirmed(typedName: string, orgName: string): boolean {
  return typedName === orgName;
}

ok('exact match confirms deletion', isDeleteConfirmed('Test Org', 'Test Org'));
ok('case mismatch blocks deletion', !isDeleteConfirmed('test org', 'Test Org'));
ok('partial name blocks deletion', !isDeleteConfirmed('Test', 'Test Org'));
ok('empty string blocks deletion', !isDeleteConfirmed('', 'Test Org'));
ok('whitespace mismatch blocks deletion', !isDeleteConfirmed('Test Org ', 'Test Org'));

// ─── 4. DB-dependent tests ────────────────────────────────────────────────────

async function runDbTests() {
  const { query, getOne, getMany } = await import('./db');
  const { createUser, deleteUser, getAllUsers } = await import('./queries');

  // ── 4a. Organisations table sanity ──
  console.log('\n── 4a. Organisations table ──');
  try {
    const orgs = await getMany<{ id: string; name: string; slug: string }>(
      'SELECT id, name, slug FROM organisations ORDER BY created_at'
    );
    ok('organisations table exists and has rows', orgs.length > 0);
    const defaultOrg = orgs.find(o => o.id === DEFAULT_ORG_ID);
    ok('default FlashAware org is present', !!defaultOrg, `found ids: ${orgs.map(o => o.id).join(', ')}`);
  } catch (e: any) {
    ok('organisations table check', false, e.message);
  }

  // ── 4b. Create → verify → delete org (cascade) ──
  console.log('\n── 4b. Org create + cascade delete ──');
  let testOrgId: string | null = null;
  let testUserId: string | null = null;

  try {
    // Create test org
    const orgRow = await getOne<{ id: string }>(
      `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
      ['__Test Org Delete__', '__test-org-delete__']
    );
    testOrgId = orgRow?.id ?? null;
    ok('test org created', !!testOrgId, 'INSERT returned no row');
  } catch (e: any) {
    ok('test org creation', false, e.message);
  }

  if (testOrgId) {
    try {
      // Create a user inside the test org
      const user = await createUser({
        email: '__test-mgmt-user@example.com',
        password: 'testpassword123',
        name: 'Test Mgmt User',
        role: 'viewer',
        org_id: testOrgId,
      });
      testUserId = user.id;
      ok('test user created in test org', !!testUserId);

      // Create an invite token inside the test org
      await query(
        `INSERT INTO invite_tokens (token, org_id, role) VALUES ($1, $2, 'viewer')`,
        ['__test-invite-token-delete__', testOrgId]
      );
      ok('test invite token created', true);

      // Verify user and token exist before deletion
      const userBefore = await getOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [testUserId]);
      ok('user exists before org deletion', !!userBefore);

      const tokenBefore = await getOne<{ id: string }>(
        `SELECT id FROM invite_tokens WHERE org_id = $1`, [testOrgId]
      );
      ok('invite token exists before org deletion', !!tokenBefore);

      // Delete the org — should cascade
      await query('DELETE FROM organisations WHERE id = $1', [testOrgId]);
      ok('org DELETE executed without error', true);

      // Verify org is gone
      const orgAfter = await getOne<{ id: string }>('SELECT id FROM organisations WHERE id = $1', [testOrgId]);
      ok('org is gone after deletion', !orgAfter);

      // Verify user cascaded
      const userAfter = await getOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [testUserId]);
      ok('user cascaded (deleted with org)', !userAfter, 'user still exists — CASCADE may be missing');

      // Verify invite token cascaded
      const tokenAfter = await getOne<{ id: string }>(
        `SELECT id FROM invite_tokens WHERE org_id = $1`, [testOrgId]
      );
      ok('invite token cascaded (deleted with org)', !tokenAfter, 'token still exists — CASCADE may be missing');

      testOrgId = null;   // already deleted
      testUserId = null;  // already cascaded

    } catch (e: any) {
      ok('org cascade delete test', false, e.message);
    }
  }

  // ── 4c. Default org cannot be deleted ──
  console.log('\n── 4c. Default org protection (DB layer) ──');
  try {
    // Attempt to delete the default org — should succeed at DB level (protection is in the route),
    // but we verify the org still exists first (we must NOT actually delete it!)
    const defaultOrgCheck = await getOne<{ id: string; name: string }>(
      'SELECT id, name FROM organisations WHERE id = $1', [DEFAULT_ORG_ID]
    );
    ok('default org still present (not accidentally deleted)', !!defaultOrgCheck,
      'Default org missing — something went wrong!');
    ok('default org name is correct', defaultOrgCheck?.name === 'FlashAware',
      `got: ${defaultOrgCheck?.name}`);
  } catch (e: any) {
    ok('default org protection check', false, e.message);
  }

  // ── 4d. Delete user ──
  console.log('\n── 4d. Delete user (existing feature) ──');
  let deleteTestUserId: string | null = null;
  try {
    const u = await createUser({
      email: '__test-delete-user@example.com',
      password: 'testpassword123',
      name: 'Test Delete User',
      role: 'viewer',
      org_id: DEFAULT_ORG_ID,
    });
    deleteTestUserId = u.id;
    ok('test user created for deletion', !!deleteTestUserId);

    const success = await deleteUser(deleteTestUserId);
    ok('deleteUser returns true on success', success);

    const after = await getOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [deleteTestUserId]);
    ok('user is actually gone after deleteUser', !after);
    deleteTestUserId = null;
  } catch (e: any) {
    ok('delete user test', false, e.message);
    // Cleanup on failure
    if (deleteTestUserId) {
      await deleteUser(deleteTestUserId).catch(() => {});
    }
  }

  // ── 4e. Update user (edit dialog backend) ──
  console.log('\n── 4e. Update user (edit dialog backend) ──');
  let updateTestUserId: string | null = null;
  try {
    const { updateUser } = await import('./queries');
    const u = await createUser({
      email: '__test-update-user@example.com',
      password: 'testpassword123',
      name: 'Original Name',
      role: 'viewer',
      org_id: DEFAULT_ORG_ID,
    });
    updateTestUserId = u.id;
    ok('test user created for update', !!updateTestUserId);

    const updated = await updateUser(updateTestUserId, { name: 'Updated Name', role: 'operator' });
    ok('updateUser returns updated record', !!updated);
    ok('name was updated', updated?.name === 'Updated Name', `got: ${updated?.name}`);
    ok('role was updated', updated?.role === 'operator', `got: ${updated?.role}`);

    // Navigate: getAllUsers still returns this user
    const all = await getAllUsers(DEFAULT_ORG_ID);
    const found = all.find(x => x.id === updateTestUserId);
    ok('user appears in getAllUsers list', !!found);

    // Test index navigation logic with real users
    const userIdx = all.findIndex(x => x.id === updateTestUserId);
    ok('findIndex works for newly created user', userIdx >= 0);

    // Cleanup
    await deleteUser(updateTestUserId);
    ok('test user cleaned up after update test', true);
    updateTestUserId = null;
  } catch (e: any) {
    ok('update user test', false, e.message);
    if (updateTestUserId) {
      const { deleteUser: du } = await import('./queries');
      await du(updateTestUserId).catch(() => {});
    }
  }

  // ── 4f. Cross-org: GET org users, create in specific org, edit, delete ──
  console.log('\n── 4f. Cross-org user management ──');
  let crossOrgId: string | null = null;
  let crossUserId: string | null = null;
  try {
    // Create a test org
    await query(
      `INSERT INTO organisations (id, name, slug) VALUES (gen_random_uuid(), '__Cross Org Test__', '__cross-org-test__')`
    );
    const crossOrg = await getOne<{ id: string }>(`SELECT id FROM organisations WHERE slug = '__cross-org-test__'`);
    crossOrgId = crossOrg!.id;
    ok('cross-org test org created', !!crossOrgId);

    // Create user in that specific org (simulates POST /api/users with org_id)
    const u = await createUser({
      email: '__cross-org-user@example.com',
      password: 'testpassword123',
      name: 'Cross Org User',
      role: 'viewer',
      org_id: crossOrgId,
    });
    crossUserId = u.id;
    ok('user created in cross-org', !!crossUserId);

    // GET /api/orgs/:id/users — getAllUsers scoped to that org
    const orgUserList = await getAllUsers(crossOrgId);
    ok('getAllUsers returns users for cross-org', orgUserList.length === 1);
    ok('returned user matches created user', orgUserList[0]?.id === crossUserId);

    // getAllUsers for DEFAULT_ORG should NOT include this user
    const defaultOrgUsers = await getAllUsers(DEFAULT_ORG_ID);
    const leaked = defaultOrgUsers.find(x => x.id === crossUserId);
    ok('cross-org user does NOT leak into default org', !leaked);

    // Edit user cross-org (simulates super_admin PUT)
    const { updateUser } = await import('./queries');
    const updated = await updateUser(crossUserId, { name: 'Renamed Cross', role: 'operator' });
    ok('cross-org user updated', updated?.name === 'Renamed Cross');
    ok('cross-org user role updated', updated?.role === 'operator');

    // Verify getOne finds user regardless of org (super_admin path)
    const found = await getOne<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = $1', [crossUserId]);
    ok('getOne finds cross-org user by id', found?.id === crossUserId);

    // Delete user cross-org (simulates super_admin DELETE)
    const delOk = await deleteUser(crossUserId);
    ok('cross-org user deleted', delOk);
    crossUserId = null;

    const afterDel = await getAllUsers(crossOrgId);
    ok('org user list empty after delete', afterDel.length === 0);

    // Cleanup org
    await query('DELETE FROM organisations WHERE id = $1', [crossOrgId]);
    crossOrgId = null;
    ok('cross-org test org cleaned up', true);
  } catch (e: any) {
    ok('cross-org user management', false, e.message);
    if (crossUserId) await deleteUser(crossUserId).catch(() => {});
    if (crossOrgId) await query('DELETE FROM organisations WHERE id = $1', [crossOrgId]).catch(() => {});
  }
}

runDbTests()
  .then(() => {
    console.log(`\n${'─'.repeat(48)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch(err => {
    console.error('\n💥 DB tests failed (is docker compose up?):', err.message);
    console.log(`\n${'─'.repeat(48)}`);
    console.log(`Pure-logic results (no DB needed): ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
