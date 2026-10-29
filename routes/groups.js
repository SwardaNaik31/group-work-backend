const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/auth');

// All group routes require authentication
router.use(authenticateToken);

/**
 * GET /api/groups
 * Return all groups that the logged-in user belongs to.
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.query(
      `SELECT 
        g.id,
        g.name,
        g.description,
        g.created_by,
        u.full_name AS creator_name,
        gm.role,
        g.created_at,
        g.updated_at,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
      FROM groups g
      JOIN group_members gm ON g.id = gm.group_id
      JOIN users u ON g.created_by = u.id
      WHERE gm.user_id = ?
      ORDER BY g.updated_at DESC, g.id DESC`,
      [userId]
    );

    res.status(200).json({
      success: true,
      groups: rows
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/groups
 * Create a new group and add initial members by email.
 * Body: { name, description, member_emails: ['user1@mail.com', 'user2@mail.com'] }
 */
router.post('/', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { name, description, member_emails } = req.body;
    const creatorId = req.user.id;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Group name is required.'
      });
    }

    await connection.beginTransaction();

    // 1. Create the group
    const [groupResult] = await connection.query(
      'INSERT INTO `groups` (name, description, created_by) VALUES (?, ?, ?)',
      [name.trim(), description?.trim() || null, creatorId]
    );
    const groupId = groupResult.insertId;

    // 2. Add creator as Admin
    await connection.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
      [groupId, creatorId, 'Admin']
    );

    // 3. Process additional member emails if provided
    let emails = [];
    if (Array.isArray(member_emails)) {
      emails = member_emails;
    } else if (typeof member_emails === 'string' && member_emails.trim()) {
      emails = member_emails.split(',').map(e => e.trim());
    }

    const addedMembers = [];
    const notFoundEmails = [];

    for (const rawEmail of emails) {
      const email = rawEmail.trim().toLowerCase();
      if (!email || email === req.user.email.toLowerCase()) continue;

      const [userRows] = await connection.query(
        'SELECT id, full_name, email FROM users WHERE LOWER(email) = ?',
        [email]
      );

      if (userRows.length > 0) {
        const foundUser = userRows[0];
        try {
          await connection.query(
            'INSERT IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
            [groupId, foundUser.id, 'Member']
          );
          addedMembers.push(foundUser.full_name);
        } catch (_) {}
      } else {
        notFoundEmails.push(email);
      }
    }

    await connection.commit();

    // Fetch created group with details
    const [createdRows] = await connection.query(
      `SELECT 
        g.id,
        g.name,
        g.description,
        g.created_by,
        u.full_name AS creator_name,
        'Admin' AS role,
        g.created_at,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
      FROM \`groups\` g
      JOIN users u ON g.created_by = u.id
      WHERE g.id = ?`,
      [groupId]
    );

    res.status(201).json({
      success: true,
      message: 'Group created successfully.',
      group: createdRows[0],
      added_members: addedMembers,
      not_found_emails: notFoundEmails
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

/**
 * GET /api/groups/:id
 * Get details and member list of a specific group.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.id, 10);
    const userId = req.user.id;

    // Verify membership
    const [membership] = await pool.query(
      'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, userId]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'You are not a member of this group.'
      });
    }

    const [groupRows] = await pool.query(
      `SELECT 
        g.id,
        g.name,
        g.description,
        g.created_by,
        u.full_name AS creator_name,
        g.created_at,
        g.updated_at
      FROM \`groups\` g
      JOIN users u ON g.created_by = u.id
      WHERE g.id = ?`,
      [groupId]
    );

    if (groupRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.'
      });
    }

    // Fetch members
    const [members] = await pool.query(
      `SELECT 
        gm.id AS membership_id,
        u.id AS user_id,
        u.full_name,
        u.email,
        u.avatar_color,
        gm.role,
        gm.created_at AS joined_at
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY gm.role = 'Admin' DESC, u.full_name ASC`,
      [groupId]
    );

    res.status(200).json({
      success: true,
      group: {
        ...groupRows[0],
        role: membership[0].role,
        member_count: members.length,
        members
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/groups/:id/members
 * Add a member by email to an existing group.
 * Body: { email }
 */
router.post('/:id/members', async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.id, 10);
    const callerId = req.user.id;
    const { email } = req.body;

    if (!email || email.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Member email is required.'
      });
    }

    // Verify caller is member
    const [membership] = await pool.query(
      'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, callerId]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'You are not a member of this group.'
      });
    }

    // Look up user by email
    const [userRows] = await pool.query(
      'SELECT id, full_name, email, avatar_color FROM users WHERE LOWER(email) = ?',
      [email.trim().toLowerCase()]
    );

    if (userRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No user found with email "${email}". Please ensure they have registered an account.`
      });
    }

    const targetUser = userRows[0];

    // Check if already in group
    const [existing] = await pool.query(
      'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, targetUser.id]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: `${targetUser.full_name} is already a member of this group.`
      });
    }

    await pool.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
      [groupId, targetUser.id, 'Member']
    );

    res.status(201).json({
      success: true,
      message: `${targetUser.full_name} added to group successfully.`,
      member: {
        user_id: targetUser.id,
        full_name: targetUser.full_name,
        email: targetUser.email,
        avatar_color: targetUser.avatar_color,
        role: 'Member'
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/groups/:id/members/:userId
 * Remove a member from the group (or leave).
 */
router.delete('/:id/members/:userId', async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.id, 10);
    const targetUserId = parseInt(req.params.userId, 10);
    const callerId = req.user.id;

    const [groupRows] = await pool.query(
      'SELECT created_by FROM `groups` WHERE id = ?',
      [groupId]
    );

    if (groupRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found.' });
    }

    const isCreator = groupRows[0].created_by === callerId;
    const isSelf = callerId === targetUserId;

    if (!isCreator && !isSelf) {
      return res.status(403).json({
        success: false,
        message: 'Only the group creator can remove other members.'
      });
    }

    // Creator cannot leave unless they delete the group
    if (isCreator && isSelf) {
      return res.status(400).json({
        success: false,
        message: 'Group creators cannot leave their own group. Delete the group instead.'
      });
    }

    await pool.query(
      'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, targetUserId]
    );

    res.status(200).json({
      success: true,
      message: isSelf ? 'You have left the group.' : 'Member removed from group.'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/groups/:id
 * Delete group (creator only).
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.id, 10);
    const callerId = req.user.id;

    const [groupRows] = await pool.query(
      'SELECT created_by FROM `groups` WHERE id = ?',
      [groupId]
    );

    if (groupRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found.' });
    }

    if (groupRows[0].created_by !== callerId) {
      return res.status(403).json({
        success: false,
        message: 'Only the creator can delete this group.'
      });
    }

    await pool.query('DELETE FROM `groups` WHERE id = ?', [groupId]);

    res.status(200).json({
      success: true,
      message: 'Group deleted successfully.'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

