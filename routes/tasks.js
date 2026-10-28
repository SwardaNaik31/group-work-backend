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
 *   - date (YYYY-MM-DD)
 *   - status ('Pending', 'In Progress', 'Completed')
 *   - user_id / member_id (integer)
 * All authenticated members can view all tasks in the shared group.
 */
router.get('/', async (req, res, next) => {
  try {
    const { date, status, user_id, member_id } = req.query;

    let query = `
      SELECT 
        t.id,
        t.user_id,
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
      WHERE 1=1
    `;
    const params = [];

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
      query += ' AND t.user_id = ?';
      params.push(parseInt(filterUserId, 10));
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
 * Fields: title (required), description (optional), task_date (default today), status (default Pending)
 */
router.post('/', async (req, res, next) => {
  try {
    const { title, description, task_date, status } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Task title is required.'
      });
    }

    const taskDate = task_date && task_date.trim() ? task_date.trim() : getTodayString();
    const taskStatus = status && VALID_STATUSES.includes(status) ? status : 'Pending';
    const cleanDescription = description && description.trim() ? description.trim() : null;

    const [result] = await pool.query(
      'INSERT INTO tasks (user_id, title, description, task_date, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, title.trim(), cleanDescription, taskDate, taskStatus]
    );

    const newTaskId = result.insertId;

    // Fetch the inserted record with owner info
    const [rows] = await pool.query(
      `SELECT 
        t.id,
        t.user_id,
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
 * PUT /api/tasks/:id
 * Edit task. Enforces backend ownership: user can only edit their own task.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID.' });
    }

    // Check if task exists and check ownership
    const [existing] = await pool.query('SELECT user_id FROM tasks WHERE id = ?', [taskId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    if (existing[0].user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You can only edit your own tasks.'
      });
    }

    const { title, description, task_date, status } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Task title is required.'
      });
    }

    const taskDate = task_date && task_date.trim() ? task_date.trim() : getTodayString();
    const taskStatus = status && VALID_STATUSES.includes(status) ? status : 'Pending';
    const cleanDescription = description !== undefined ? (description && description.trim() ? description.trim() : null) : null;

    await pool.query(
      'UPDATE tasks SET title = ?, description = ?, task_date = ?, status = ? WHERE id = ?',
      [title.trim(), cleanDescription, taskDate, taskStatus, taskId]
    );

    const [updated] = await pool.query(
      `SELECT 
        t.id,
        t.user_id,
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
      message: 'Task updated successfully.',
      task: updated[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/tasks/:id/status
 * Quick status update. Enforces backend ownership: user can only change their own task status.
 */
router.patch('/:id/status', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID.' });
    }

    const { status } = req.body;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`
      });
    }

    // Check ownership
    const [existing] = await pool.query('SELECT user_id FROM tasks WHERE id = ?', [taskId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    if (existing[0].user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You can only update the status of your own tasks.'
      });
    }

    await pool.query('UPDATE tasks SET status = ? WHERE id = ?', [status, taskId]);

    const [updated] = await pool.query(
      `SELECT 
        t.id,
        t.user_id,
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
      message: 'Task status updated successfully.',
      task: updated[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/tasks/:id
 * Delete task. Enforces backend ownership: user can only delete their own task.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID.' });
    }

    const [existing] = await pool.query('SELECT user_id FROM tasks WHERE id = ?', [taskId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    if (existing[0].user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You can only delete your own tasks.'
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
