const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/auth');

router.use(authenticateToken);

function getTodayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * GET /api/summary/daily?date=YYYY-MM-DD
 * Calculates the comprehensive evening summary from live database records
 */
router.get('/daily', async (req, res, next) => {
  try {
    const targetDate = req.query.date && req.query.date.trim() ? req.query.date.trim() : getTodayString();

    // 1. Fetch group overall metrics for targetDate
    const metricsQuery = `
      SELECT 
        COUNT(id) AS total_tasks,
        SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed_tasks,
        SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress_tasks,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pending_tasks
      FROM tasks 
      WHERE task_date = ?
    `;

    const [metricRows] = await pool.query(metricsQuery, [targetDate]);
    const metrics = metricRows[0];

    const total = Number(metrics.total_tasks) || 0;
    const completed = Number(metrics.completed_tasks) || 0;
    const inProgress = Number(metrics.in_progress_tasks) || 0;
    const pending = Number(metrics.pending_tasks) || 0;
    const completionPercentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    // 2. Fetch per-member stats for targetDate
    const memberQuery = `
      SELECT 
        u.id,
        u.full_name,
        u.email,
        u.avatar_color,
        COUNT(t.id) AS total_tasks,
        SUM(CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END) AS completed_tasks,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress_tasks,
        SUM(CASE WHEN t.status = 'Pending' THEN 1 ELSE 0 END) AS pending_tasks
      FROM users u
      LEFT JOIN tasks t ON u.id = t.user_id AND t.task_date = ?
      GROUP BY u.id, u.full_name, u.email, u.avatar_color
      ORDER BY total_tasks DESC, u.full_name ASC
    `;

    const [memberRows] = await pool.query(memberQuery, [targetDate]);

    const memberBreakdown = memberRows.map(m => {
      const mTotal = Number(m.total_tasks) || 0;
      const mCompleted = Number(m.completed_tasks) || 0;
      const mInProgress = Number(m.in_progress_tasks) || 0;
      const mPending = Number(m.pending_tasks) || 0;
      const mPercentage = mTotal > 0 ? Math.round((mCompleted / mTotal) * 100) : 0;

      return {
        id: m.id,
        full_name: m.full_name,
        email: m.email,
        avatar_color: m.avatar_color,
        total_tasks: mTotal,
        completed_tasks: mCompleted,
        in_progress_tasks: mInProgress,
        pending_tasks: mPending,
        completion_percentage: mPercentage
      };
    });

    // 3. Fetch completed tasks for targetDate
    const completedTasksQuery = `
      SELECT 
        t.id,
        t.title,
        t.description,
        t.task_date,
        t.status,
        t.updated_at,
        u.id AS user_id,
        u.full_name AS owner_name,
        u.avatar_color AS owner_avatar
      FROM tasks t
      JOIN users u ON t.user_id = u.id
      WHERE t.task_date = ? AND t.status = 'Completed'
      ORDER BY t.updated_at DESC
    `;
    const [completedTasks] = await pool.query(completedTasksQuery, [targetDate]);

    // 4. Fetch unfinished tasks for targetDate (Pending + In Progress)
    const unfinishedTasksQuery = `
      SELECT 
        t.id,
        t.title,
        t.description,
        t.task_date,
        t.status,
        t.created_at,
        u.id AS user_id,
        u.full_name AS owner_name,
        u.avatar_color AS owner_avatar
      FROM tasks t
      JOIN users u ON t.user_id = u.id
      WHERE t.task_date = ? AND t.status IN ('Pending', 'In Progress')
      ORDER BY t.status DESC, t.created_at ASC
    `;
    const [unfinishedTasks] = await pool.query(unfinishedTasksQuery, [targetDate]);

    return res.status(200).json({
      success: true,
      date: targetDate,
      summary: {
        total_tasks: total,
        completed_tasks: completed,
        in_progress_tasks: inProgress,
        pending_tasks: pending,
        completion_percentage: completionPercentage
      },
      member_breakdown: memberBreakdown,
      completed_tasks: completedTasks,
      unfinished_tasks: unfinishedTasks
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
