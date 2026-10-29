const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/auth');

router.use(authenticateToken);

/**
 * GET /api/meetings
 * Meetings are strictly for GROUPS.
 * Returns meetings only when a valid group_id is provided.
 */
router.get('/', async (req, res, next) => {
  try {
    const { group_id } = req.query;
    const currentUserId = req.user.id;

    // Single users have no meetings - meetings are strictly for groups
    if (!group_id || group_id === 'personal' || parseInt(group_id, 10) === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        upcoming_count: 0,
        past_count: 0,
        upcoming_meetings: [],
        past_meetings: [],
        meetings: []
      });
    }

    const parsedGroupId = parseInt(group_id, 10);
    // Verify membership
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

    const query = `
      SELECT 
        m.id,
        m.created_by,
        m.group_id,
        m.title,
        m.agenda,
        m.agenda AS description,
        m.meeting_link,
        m.meeting_date,
        m.meeting_time,
        m.created_at,
        m.updated_at,
        u.full_name AS creator_name,
        u.email AS creator_email,
        u.avatar_color AS creator_avatar,
        g.name AS group_name
      FROM meetings m
      JOIN users u ON m.created_by = u.id
      JOIN \`groups\` g ON m.group_id = g.id
      WHERE m.group_id = ?
      ORDER BY m.meeting_date ASC, m.meeting_time ASC
    `;

    const [rows] = await pool.query(query, [parsedGroupId]);

    const now = new Date();
    const upcoming = [];
    const past = [];

    rows.forEach(m => {
      const timeStr = m.meeting_time.length === 5 ? `${m.meeting_time}:00` : m.meeting_time;
      const meetingDateTime = new Date(`${m.meeting_date}T${timeStr}`);
      const isUpcoming = meetingDateTime >= now;

      const meetingObj = {
        ...m,
        is_upcoming: isUpcoming,
        formatted_date: m.meeting_date,
        formatted_time: m.meeting_time.substring(0, 5)
      };

      if (isUpcoming) {
        upcoming.push(meetingObj);
      } else {
        past.push(meetingObj);
      }
    });

    past.sort((a, b) => {
      const dtA = new Date(`${a.meeting_date}T${a.meeting_time}`);
      const dtB = new Date(`${b.meeting_date}T${b.meeting_time}`);
      return dtB - dtA;
    });

    return res.status(200).json({
      success: true,
      count: rows.length,
      upcoming_count: upcoming.length,
      past_count: past.length,
      upcoming_meetings: upcoming,
      past_meetings: past,
      meetings: rows
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/meetings/:id
 */
router.get('/:id', async (req, res, next) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    if (isNaN(meetingId)) {
      return res.status(400).json({ success: false, message: 'Invalid meeting ID.' });
    }

    const [rows] = await pool.query(
      `SELECT 
        m.id,
        m.created_by,
        m.group_id,
        m.title,
        m.agenda,
        m.agenda AS description,
        m.meeting_link,
        m.meeting_date,
        m.meeting_time,
        m.created_at,
        m.updated_at,
        u.full_name AS creator_name,
        u.email AS creator_email,
        u.avatar_color AS creator_avatar,
        g.name AS group_name
      FROM meetings m
      JOIN users u ON m.created_by = u.id
      JOIN \`groups\` g ON m.group_id = g.id
      WHERE m.id = ?`,
      [meetingId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }

    return res.status(200).json({
      success: true,
      meeting: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/meetings
 * Strictly requires group_id (meetings are only for groups).
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      title,
      agenda,
      description,
      meeting_link,
      meetingLink,
      meeting_date,
      meetingDate,
      meeting_time,
      meetingTime,
      group_id
    } = req.body;

    const currentUserId = req.user.id;

    if (!group_id || parseInt(group_id, 10) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Meetings are only available for groups. Please select a group.'
      });
    }

    const targetGroupId = parseInt(group_id, 10);
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

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Meeting title is required.'
      });
    }

    const mDate = (meeting_date || meetingDate || '').trim();
    if (!mDate) {
      return res.status(400).json({
        success: false,
        message: 'Meeting date (YYYY-MM-DD) is required.'
      });
    }

    const mTime = (meeting_time || meetingTime || '').trim();
    if (!mTime) {
      return res.status(400).json({
        success: false,
        message: 'Meeting time (HH:mm) is required.'
      });
    }

    const cleanAgenda = (agenda || description || '').trim() || null;
    const cleanLink = (meeting_link || meetingLink || '').trim() || null;
    const formattedTime = mTime.length === 5 ? `${mTime}:00` : mTime;

    const [result] = await pool.query(
      'INSERT INTO meetings (created_by, group_id, title, agenda, meeting_link, meeting_date, meeting_time) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [currentUserId, targetGroupId, title.trim(), cleanAgenda, cleanLink, mDate, formattedTime]
    );

    const newMeetingId = result.insertId;

    const [rows] = await pool.query(
      `SELECT 
        m.id,
        m.created_by,
        m.group_id,
        m.title,
        m.agenda,
        m.agenda AS description,
        m.meeting_link,
        m.meeting_date,
        m.meeting_time,
        m.created_at,
        m.updated_at,
        u.full_name AS creator_name,
        u.email AS creator_email,
        u.avatar_color AS creator_avatar,
        g.name AS group_name
      FROM meetings m
      JOIN users u ON m.created_by = u.id
      JOIN \`groups\` g ON m.group_id = g.id
      WHERE m.id = ?`,
      [newMeetingId]
    );

    return res.status(201).json({
      success: true,
      message: 'Group meeting scheduled successfully.',
      meeting: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/meetings/:id
 */
router.put('/:id', async (req, res, next) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    const currentUserId = req.user.id;

    if (isNaN(meetingId)) {
      return res.status(400).json({ success: false, message: 'Invalid meeting ID.' });
    }

    const [existing] = await pool.query(
      'SELECT created_by, group_id FROM meetings WHERE id = ?',
      [meetingId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }

    const meeting = existing[0];
    let canEdit = meeting.created_by === currentUserId;

    if (!canEdit && meeting.group_id) {
      const [adminCheck] = await pool.query(
        "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role = 'Admin'",
        [meeting.group_id, currentUserId]
      );
      if (adminCheck.length > 0) canEdit = true;
    }

    if (!canEdit) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Only the meeting creator or group admin can edit this meeting.'
      });
    }

    const {
      title,
      agenda,
      description,
      meeting_link,
      meetingLink,
      meeting_date,
      meetingDate,
      meeting_time,
      meetingTime
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Meeting title is required.' });
    }

    const mDate = (meeting_date || meetingDate || '').trim();
    const mTime = (meeting_time || meetingTime || '').trim();
    if (!mDate || !mTime) {
      return res.status(400).json({ success: false, message: 'Meeting date and time are required.' });
    }

    const cleanAgenda = (agenda || description || '').trim() || null;
    const cleanLink = (meeting_link || meetingLink || '').trim() || null;
    const formattedTime = mTime.length === 5 ? `${mTime}:00` : mTime;

    await pool.query(
      'UPDATE meetings SET title = ?, agenda = ?, meeting_link = ?, meeting_date = ?, meeting_time = ? WHERE id = ?',
      [title.trim(), cleanAgenda, cleanLink, mDate, formattedTime, meetingId]
    );

    const [rows] = await pool.query(
      `SELECT 
        m.id,
        m.created_by,
        m.group_id,
        m.title,
        m.agenda,
        m.agenda AS description,
        m.meeting_link,
        m.meeting_date,
        m.meeting_time,
        m.created_at,
        m.updated_at,
        u.full_name AS creator_name,
        u.email AS creator_email,
        u.avatar_color AS creator_avatar,
        g.name AS group_name
      FROM meetings m
      JOIN users u ON m.created_by = u.id
      JOIN \`groups\` g ON m.group_id = g.id
      WHERE m.id = ?`,
      [meetingId]
    );

    return res.status(200).json({
      success: true,
      message: 'Meeting updated successfully.',
      meeting: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/meetings/:id
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    const currentUserId = req.user.id;

    if (isNaN(meetingId)) {
      return res.status(400).json({ success: false, message: 'Invalid meeting ID.' });
    }

    const [existing] = await pool.query(
      'SELECT created_by, group_id FROM meetings WHERE id = ?',
      [meetingId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }

    const meeting = existing[0];
    let canDelete = meeting.created_by === currentUserId;

    if (!canDelete && meeting.group_id) {
      const [adminCheck] = await pool.query(
        "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role = 'Admin'",
        [meeting.group_id, currentUserId]
      );
      if (adminCheck.length > 0) canDelete = true;
    }

    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Only the creator or group admin can delete this meeting.'
      });
    }

    await pool.query('DELETE FROM meetings WHERE id = ?', [meetingId]);

    return res.status(200).json({
      success: true,
      message: 'Meeting deleted successfully.'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
