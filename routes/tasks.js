const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/auth');

// All task routes require authentication
router.use(authenticateToken);

const VALID_STATUSES = ['Pending', 'In Progress', 'Completed'];

/**
 * Helper: get today's date formatted as YYYY-MM-DD in local time
 */
function getTodayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * GET /api/tasks
 * Query params:
 *   - group_id ('personal' or integer ID)
 *   - date (YYYY-MM-DD)
 *   - status ('Pending', 'In Progress', 'Completed')
 *   - user_id / member_id (integer)
 */
router.get('/', async (req, res, next) => {
  try {
    const { date, status, user_id, member_id, group_id } = req.query;
    const currentUserId = req.user.id;

    let query = `
      SELECT 
        t.id,
        t.user_id,
        t.group_id,
        t.assigned_by,
        t.title,
        t.description,
        t.task_date,
        t.status,
        t.created_at,
        t.updated_at,
        u.full_name AS owner_name,
        u.email AS owner_email,
        u.avatar_color AS owner_avatar,
        assigner.full_name AS assigner_name,
        g.name AS group_name
      FROM tasks t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN users assigner ON t.assigned_by = assigner.id
      LEFT JOIN \`groups\` g ON t.group_id = g.id
      WHERE 1=1
    `;
    const params = [];

    let targetGroupId = group_id;

    if (targetGroupId !== undefined && targetGroupId !== null && targetGroupId !== '' && targetGroupId !== 'all') {
      if (targetGroupId === 'personal' || parseInt(targetGroupId, 10) === 0) {
        // Personal tasks of current user ONLY
        query += ' AND t.group_id IS NULL AND t.user_id = ?';
        params.push(currentUserId);
      } else {
        const parsedGroupId = parseInt(targetGroupId, 10);
        // Verify caller is a member of this group
        const [membership] = await pool.query(
          'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
          [parsedGroupId, currentUserId]
        );
        if (membership.length === 0) {
          return res.status(403).json({
            success: false,
            message: 'You are not a member of this group.'
          });
        }
        // Return all tasks belonging to this group
        query += ' AND t.group_id = ?';
        params.push(parsedGroupId);
      }
    } else {
      // Default: ONLY show tasks from people who share at least one group with current user (in those groups), OR current user's own tasks
      query += ` AND (
        (t.user_id = ?)
        OR (
          t.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
          AND t.user_id IN (
            SELECT gm2.user_id 
            FROM group_members gm1 
            JOIN group_members gm2 ON gm1.group_id = gm2.group_id 
            WHERE gm1.user_id = ?
          )
        )
      )`;
      params.push(currentUserId, currentUserId, currentUserId);
    }

    if (date) {
      query += ' AND t.task_date = ?';
      params.push(date);
    }

    if (status && VALID_STATUSES.includes(status)) {
      query += ' AND t.status = ?';
      params.push(status);
    }

    const filterUserId = user_id || member_id;
    if (filterUserId) {
      const parsedUid = parseInt(filterUserId, 10);
      query += ' AND (t.user_id = ? OR t.assigned_by = ?)';
      params.push(parsedUid, parsedUid);
    }

    // Order: selected date or recent first, then newest created
    query += ' ORDER BY t.task_date DESC, t.created_at DESC';

    const [tasks] = await pool.query(query, params);

    return res.status(200).json({
      success: true,
      count: tasks.length,
      tasks
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tasks/:id
 * Get single task detail
 */
router.get('/:id', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID.' });
    }

    const [rows] = await pool.query(
      `SELECT 
        t.id,
        t.user_id,
        t.group_id,
        t.assigned_by,
        t.title,
        t.description,
        t.task_date,
        t.status,
        t.created_at,
        t.updated_at,
        u.full_name AS owner_name,
        u.email AS owner_email,
        u.avatar_color AS owner_avatar,
        assigner.full_name AS assigner_name,
        g.name AS group_name
      FROM tasks t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN users assigner ON t.assigned_by = assigner.id
      LEFT JOIN \`groups\` g ON t.group_id = g.id
      WHERE t.id = ?`,
      [taskId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    return res.status(200).json({
      success: true,
      task: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tasks
 * Create a new task.
 * Supports:
 *   - Personal task: group_id = null
 *   - Group task: group_id != null, with optional assigned_to (assign to another group member)
 */
router.post('/', async (req, res, next) => {
  try {
    const { title, description, task_date, status, group_id, assigned_to } = req.body;
    const currentUserId = req.user.id;

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Task title is required.'
      });
    }

    let targetGroupId = null;
    let targetUserId = currentUserId;

    if (group_id && group_id !== 'personal' && parseInt(group_id, 10) > 0) {
      targetGroupId = parseInt(group_id, 10);

      // Verify creator is member of the group
      const [membership] = await pool.query(
        'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
        [targetGroupId, currentUserId]
      );
      if (membership.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'You are not a member of this group.'
        });
      }

      // If assigned_to is specified, verify assignee belongs to the group
      if (assigned_to && parseInt(assigned_to, 10) > 0) {
        targetUserId = parseInt(assigned_to, 10);
        const [assigneeMem] = await pool.query(
          'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
          [targetGroupId, targetUserId]
        );
        if (assigneeMem.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'The assigned user is not a member of this group.'
          });
        }
      }
    } else {
      // Explicitly a personal task: strictly assigned to current user with no group
      targetGroupId = null;
      targetUserId = currentUserId;
    }

    const taskDate = task_date && task_date.trim() ? task_date.trim() : getTodayString();
    const taskStatus = status && VALID_STATUSES.includes(status) ? status : 'Pending';
    const cleanDescription = description && description.trim() ? description.trim() : null;

    const [result] = await pool.query(
      'INSERT INTO tasks (user_id, group_id, assigned_by, title, description, task_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [targetUserId, targetGroupId, currentUserId, title.trim(), cleanDescription, taskDate, taskStatus]
    );

    const newTaskId = result.insertId;

    // Fetch inserted record with owner & assigner info
    const [rows] = await pool.query(
      `SELECT 
        t.id,
        t.user_id,
        t.group_id,
        t.assigned_by,
        t.title,
        t.description,
        t.task_date,
        t.status,
        t.created_at,
        t.updated_at,
        u.full_name AS owner_name,
        u.email AS owner_email,
        u.avatar_color AS owner_avatar,
        assigner.full_name AS assigner_name,
        g.name AS group_name
      FROM tasks t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN users assigner ON t.assigned_by = assigner.id
      LEFT JOIN \`groups\` g ON t.group_id = g.id
      WHERE t.id = ?`,
      [newTaskId]
    );

    return res.status(201).json({
      success: true,
      message: 'Task created successfully.',
      task: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tasks/copy-day
 * Bulk copy tasks from a source date (e.g. yesterday) to a target date (e.g. today or next day)
 * Body: { source_date: 'YYYY-MM-DD', target_date?: 'YYYY-MM-DD', task_ids?: number[], group_id?: number|string }
 */
router.post('/copy-day', async (req, res, next) => {
  try {
    const currentUserId = req.user.id;
    const { source_date, target_date, task_ids, group_id } = req.body;
    const targetDate = target_date && target_date.trim() ? target_date.trim() : getTodayString();

    if (!source_date || !source_date.trim()) {
      return res.status(400).json({ success: false, message: 'source_date is required.' });
    }

    let query = `
      SELECT t.* 
      FROM tasks t
      WHERE t.task_date = ?
        AND (t.user_id = ? OR t.assigned_by = ?)
    `;
    const params = [source_date.trim(), currentUserId, currentUserId];

    if (group_id !== undefined && group_id !== null && group_id !== '' && group_id !== 'all') {
      if (group_id === 'personal' || parseInt(group_id, 10) === 0) {
        query += ' AND t.group_id IS NULL';
      } else {
        query += ' AND t.group_id = ?';
        params.push(parseInt(group_id, 10));
      }
    }

    if (Array.isArray(task_ids) && task_ids.length > 0) {
      query += ` AND t.id IN (?)`;
      params.push(task_ids);
    }

    query += ' ORDER BY t.created_at ASC';

    const [sourceTasks] = await pool.query(query, params);

    if (sourceTasks.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No tasks found for the specified date.',
        count: 0,
        tasks: []
      });
    }

    const insertedIds = [];
    for (const t of sourceTasks) {
      const [insertResult] = await pool.query(
        `INSERT INTO tasks (user_id, group_id, assigned_by, title, description, task_date, status)
         VALUES (?, ?, ?, ?, ?, ?, 'Pending')`,
        [
          t.user_id,
          t.group_id,
          t.group_id ? currentUserId : null,
          t.title,
          t.description,
          targetDate
        ]
      );
      insertedIds.push(insertResult.insertId);
    }

    const [newTasks] = await pool.query(
      `SELECT t.*, u.full_name AS owner_name, u.email AS owner_email, u.avatar_color AS owner_avatar,
              assigner.full_name AS assigner_name, g.name AS group_name
       FROM tasks t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN users assigner ON t.assigned_by = assigner.id
       LEFT JOIN \`groups\` g ON t.group_id = g.id
       WHERE t.id IN (?)
       ORDER BY t.created_at ASC`,
      [insertedIds]
    );

    return res.status(201).json({
      success: true,
      message: `Copied ${newTasks.length} task(s) to ${targetDate}.`,
      count: newTasks.length,
      tasks: newTasks
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tasks/:id/duplicate
 * Duplicate a single task to target_date (defaults to today or tomorrow)
 * Body: { target_date?: 'YYYY-MM-DD' }
 */
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const currentUserId = req.user.id;
    const { target_date } = req.body;
    const targetDate = target_date && target_date.trim() ? target_date.trim() : getTodayString();

    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID.' });
    }

    const [existing] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const task = existing[0];
    let canCopy = task.user_id === currentUserId || task.assigned_by === currentUserId;
    if (!canCopy && task.group_id) {
      const [memberCheck] = await pool.query(
        'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
        [task.group_id, currentUserId]
      );
      if (memberCheck.length > 0) canCopy = true;
    }

    if (!canCopy) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to duplicate this task.' });
    }

    const [result] = await pool.query(
      `INSERT INTO tasks (user_id, group_id, assigned_by, title, description, task_date, status)
       VALUES (?, ?, ?, ?, ?, ?, 'Pending')`,
      [
        task.user_id,
        task.group_id,
        task.group_id ? currentUserId : null,
        task.title,
        task.description,
        targetDate
      ]
    );

    const [rows] = await pool.query(
      `SELECT t.*, u.full_name AS owner_name, u.email AS owner_email, u.avatar_color AS owner_avatar,
              assigner.full_name AS assigner_name, g.name AS group_name
       FROM tasks t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN users assigner ON t.assigned_by = assigner.id
       LEFT JOIN \`groups\` g ON t.group_id = g.id
       WHERE t.id = ?`,
      [result.insertId]
    );

    return res.status(201).json({
      success: true,
      message: 'Task duplicated successfully.',
      task: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/tasks/:id
 * Edit task. Allows assignee, assigner, or group admin to edit.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const currentUserId = req.user.id;

    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID.' });
    }

    const [existing] = await pool.query(
      'SELECT user_id, group_id, assigned_by FROM tasks WHERE id = ?',
      [taskId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const task = existing[0];
    let canEdit = task.user_id === currentUserId || task.assigned_by === currentUserId;

    if (!canEdit && task.group_id) {
      // Check if user is a member of this group
      const [memberCheck] = await pool.query(
        "SELECT id FROM group_members WHERE group_id = ? AND user_id = ?",
        [task.group_id, currentUserId]
      );
      if (memberCheck.length > 0) canEdit = true;
    }

    if (!canEdit) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not have permission to edit this task.'
      });
    }

    const { title, description, task_date, status, assigned_to } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Task title is required.'
      });
    }

    const taskDate = task_date && task_date.trim() ? task_date.trim() : getTodayString();
    const taskStatus = status && VALID_STATUSES.includes(status) ? status : 'Pending';
    const cleanDescription = description !== undefined ? (description && description.trim() ? description.trim() : null) : null;

    let targetUserId = task.user_id;
    if (task.group_id && assigned_to && parseInt(assigned_to, 10) > 0) {
      targetUserId = parseInt(assigned_to, 10);
    }

    await pool.query(
      'UPDATE tasks SET title = ?, description = ?, task_date = ?, status = ?, user_id = ? WHERE id = ?',
      [title.trim(), cleanDescription, taskDate, taskStatus, targetUserId, taskId]
    );

    const [rows] = await pool.query(
      `SELECT 
        t.id,
        t.user_id,
        t.group_id,
        t.assigned_by,
        t.title,
        t.description,
        t.task_date,
        t.status,
        t.created_at,
        t.updated_at,
        u.full_name AS owner_name,
        u.email AS owner_email,
        u.avatar_color AS owner_avatar,
        assigner.full_name AS assigner_name,
        g.name AS group_name
      FROM tasks t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN users assigner ON t.assigned_by = assigner.id
      LEFT JOIN \`groups\` g ON t.group_id = g.id
      WHERE t.id = ?`,
      [taskId]
    );

    return res.status(200).json({
      success: true,
      message: 'Task updated successfully.',
      task: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/tasks/:id/status
 * Quick update task status
 */
router.patch('/:id/status', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { status } = req.body;
    const currentUserId = req.user.id;

    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID.' });
    }

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${VALID_STATUSES.join(', ')}.`
      });
    }

    const [existing] = await pool.query(
      'SELECT user_id, group_id, assigned_by FROM tasks WHERE id = ?',
      [taskId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const task = existing[0];
    let canUpdate = task.user_id === currentUserId || task.assigned_by === currentUserId;

    if (!canUpdate && task.group_id) {
      const [groupMem] = await pool.query(
        'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
        [task.group_id, currentUserId]
      );
      if (groupMem.length > 0) canUpdate = true;
    }

    if (!canUpdate) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not have permission to update this task status.'
      });
    }

    await pool.query('UPDATE tasks SET status = ? WHERE id = ?', [status, taskId]);

    const [rows] = await pool.query(
      `SELECT 
        t.id,
        t.user_id,
        t.group_id,
        t.assigned_by,
        t.title,
        t.description,
        t.task_date,
        t.status,
        t.created_at,
        t.updated_at,
        u.full_name AS owner_name,
        u.email AS owner_email,
        u.avatar_color AS owner_avatar
      FROM tasks t
      JOIN users u ON t.user_id = u.id
      WHERE t.id = ?`,
      [taskId]
    );

    return res.status(200).json({
      success: true,
      message: 'Task status updated.',
      task: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/tasks/:id
 * Delete task
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const currentUserId = req.user.id;

    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID.' });
    }

    const [existing] = await pool.query(
      'SELECT user_id, group_id, assigned_by FROM tasks WHERE id = ?',
      [taskId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const task = existing[0];
    let canDelete = task.user_id === currentUserId || task.assigned_by === currentUserId;

    if (!canDelete && task.group_id) {
      // Check if user is a member of this group
      const [memberCheck] = await pool.query(
        "SELECT id FROM group_members WHERE group_id = ? AND user_id = ?",
        [task.group_id, currentUserId]
      );
      if (memberCheck.length > 0) canDelete = true;
    }

    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not have permission to delete this task.'
      });
    }

    await pool.query('DELETE FROM tasks WHERE id = ?', [taskId]);

    return res.status(200).json({
      success: true,
      message: 'Task deleted successfully.'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
