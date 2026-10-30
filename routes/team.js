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
 * Returns registered members.
 * If group_id is specified: returns members of that group.
 * Otherwise returns members of groups the user belongs to (or directory).
 */
router.get('/', async (req, res, next) => {
  try {
    const { group_id } = req.query;
    const currentUserId = req.user.id;

    if (group_id && parseInt(group_id, 10) > 0) {
      const parsedGroupId = parseInt(group_id, 10);
      const [members] = await pool.query(
        `SELECT u.id, u.full_name, u.email, u.avatar_color, gm.role, gm.created_at 
         FROM group_members gm
         JOIN users u ON gm.user_id = u.id
         WHERE gm.group_id = ?
         ORDER BY gm.role = 'Admin' DESC, u.full_name ASC`,
        [parsedGroupId]
      );
      return res.status(200).json({ success: true, count: members.length, members });
    }

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
 * Query params: ?date=YYYY-MM-DD&group_id=...
 * If group_id is provided: calculates stats for that group.
 * If group_id === 'personal' or not provided: calculates personal stats for current user only.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const targetDate = req.query.date && req.query.date.trim() ? req.query.date.trim() : getTodayString();
    const { group_id } = req.query;
    const currentUserId = req.user.id;

    let isGroup = group_id && group_id !== 'personal' && parseInt(group_id, 10) > 0;
    let groupId = isGroup ? parseInt(group_id, 10) : null;

    if (!groupId && group_id !== 'personal') {
      const [userGroups] = await pool.query(
        'SELECT group_id FROM group_members WHERE user_id = ? ORDER BY id ASC LIMIT 1',
        [currentUserId]
      );
      if (userGroups.length > 0) {
        groupId = userGroups[0].group_id;
        isGroup = true;
      }
    }

    let query;
    let params;

    if (isGroup) {
      // Group mode: members of this specific group and their tasks in this group
      query = `
        SELECT 
          u.id,
          u.full_name,
          u.email,
          u.avatar_color,
          u.created_at,
          gm.role,
          COUNT(t.id) AS total_tasks,
          SUM(CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END) AS completed_tasks,
          SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress_tasks,
          SUM(CASE WHEN t.status = 'Pending' THEN 1 ELSE 0 END) AS pending_tasks
        FROM group_members gm
        JOIN users u ON gm.user_id = u.id
        LEFT JOIN tasks t ON u.id = t.user_id AND t.task_date = ? AND t.group_id = ?
        WHERE gm.group_id = ?
        GROUP BY u.id, u.full_name, u.email, u.avatar_color, u.created_at, gm.role
        ORDER BY completed_tasks DESC, total_tasks DESC, u.full_name ASC
      `;
      params = [targetDate, groupId, groupId];
    } else {
      // Personal mode: ONLY current user and their personal tasks
      query = `
        SELECT 
          u.id,
          u.full_name,
          u.email,
          u.avatar_color,
          u.created_at,
          'Solo' AS role,
          COUNT(t.id) AS total_tasks,
          SUM(CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END) AS completed_tasks,
          SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress_tasks,
          SUM(CASE WHEN t.status = 'Pending' THEN 1 ELSE 0 END) AS pending_tasks
        FROM users u
        LEFT JOIN tasks t ON u.id = t.user_id AND t.task_date = ? AND t.group_id IS NULL
        WHERE u.id = ?
        GROUP BY u.id, u.full_name, u.email, u.avatar_color, u.created_at
      `;
      params = [targetDate, currentUserId];
    }

    const [rows] = await pool.query(query, params);

    let totalGroupTasks = 0;
    let completedGroupTasks = 0;
    let inProgressGroupTasks = 0;
    let pendingGroupTasks = 0;

    const memberStats = rows.map(r => {
      const tot = Number(r.total_tasks) || 0;
      const comp = Number(r.completed_tasks) || 0;
      const inProg = Number(r.in_progress_tasks) || 0;
      const pend = Number(r.pending_tasks) || 0;
      const pct = tot > 0 ? Math.round((comp / tot) * 100) : 0;

      totalGroupTasks += tot;
      completedGroupTasks += comp;
      inProgressGroupTasks += inProg;
      pendingGroupTasks += pend;

      return {
        id: r.id,
        fullName: r.full_name,
        email: r.email,
        avatarColor: r.avatar_color,
        totalTasks: tot,
        completedTasks: comp,
        inProgressTasks: inProg,
        pendingTasks: pend,
        completionPercentage: pct
      };
    });

    const overallPercentage = totalGroupTasks > 0
      ? Math.round((completedGroupTasks / totalGroupTasks) * 100)
      : 0;

    return res.status(200).json({
      success: true,
      date: targetDate,
      mode: isGroup ? 'group' : 'personal',
      group_summary: {
        total_tasks: totalGroupTasks,
        completed_tasks: completedGroupTasks,
        in_progress_tasks: inProgressGroupTasks,
        pending_tasks: pendingGroupTasks,
        completion_percentage: overallPercentage
      },
      members: memberStats
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
