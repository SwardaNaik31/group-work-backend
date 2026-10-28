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
 * GET /api/team
 * Returns all registered members of the shared group
 */
router.get('/', async (req, res, next) => {
  try {
    const [members] = await pool.query(
      `SELECT id, full_name, email, avatar_color, created_at 
       FROM users 
       ORDER BY full_name ASC`
    );

    return res.status(200).json({
      success: true,
      count: members.length,
      members
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/team/summary
 * Query params: ?date=YYYY-MM-DD
 * Returns detailed task breakdown for each team member on the specified date
 */
router.get('/summary', async (req, res, next) => {
  try {
    const targetDate = req.query.date && req.query.date.trim() ? req.query.date.trim() : getTodayString();

    // Query all members with aggregate counts for the specific date
    const query = `
      SELECT 
        u.id,
        u.full_name,
        u.email,
        u.avatar_color,
        u.created_at,
        COUNT(t.id) AS total_tasks,
        SUM(CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END) AS completed_tasks,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress_tasks,
        SUM(CASE WHEN t.status = 'Pending' THEN 1 ELSE 0 END) AS pending_tasks
      FROM users u
      LEFT JOIN tasks t ON u.id = t.user_id AND t.task_date = ?
      GROUP BY u.id, u.full_name, u.email, u.avatar_color, u.created_at
      ORDER BY total_tasks DESC, u.full_name ASC
    `;

    const [rows] = await pool.query(query, [targetDate]);

    let groupTotal = 0;
    let groupCompleted = 0;
    let groupInProgress = 0;
    let groupPending = 0;

    const memberStats = rows.map(row => {
      const total = Number(row.total_tasks) || 0;
      const completed = Number(row.completed_tasks) || 0;
      const inProgress = Number(row.in_progress_tasks) || 0;
      const pending = Number(row.pending_tasks) || 0;

      groupTotal += total;
      groupCompleted += completed;
      groupInProgress += inProgress;
      groupPending += pending;

      const completionPercentage = total > 0 ? Math.round((completed / total) * 100) : 0;

      return {
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        avatar_color: row.avatar_color,
        total_tasks: total,
        completed_tasks: completed,
        in_progress_tasks: inProgress,
        pending_tasks: pending,
        completion_percentage: completionPercentage
      };
    });

    const groupCompletionPercentage = groupTotal > 0 ? Math.round((groupCompleted / groupTotal) * 100) : 0;

    return res.status(200).json({
      success: true,
      date: targetDate,
      group_summary: {
        total_tasks: groupTotal,
        completed_tasks: groupCompleted,
        in_progress_tasks: groupInProgress,
        pending_tasks: groupPending,
        completion_percentage: groupCompletionPercentage
      },
      members: memberStats
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
