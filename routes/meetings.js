const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/auth');

router.use(authenticateToken);

/**
 * GET /api/meetings
 * Returns all meetings with creator information.
 * Sorts upcoming meetings first (soonest first), followed by past meetings (most recent past first).
 */
router.get('/', async (req, res, next) => {
  try {
    const query = `
      SELECT 
        m.id,
        m.created_by,
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
        u.avatar_color AS creator_avatar
      FROM meetings m
      JOIN users u ON m.created_by = u.id
      ORDER BY m.meeting_date ASC, m.meeting_time ASC
    `;

    const [rows] = await pool.query(query);

    const now = new Date();

    const upcoming = [];
    const past = [];

    rows.forEach(m => {
      // Parse meeting timestamp
      // meeting_date: 'YYYY-MM-DD', meeting_time: 'HH:mm:ss'
      const timeStr = m.meeting_time.length === 5 ? `${m.meeting_time}:00` : m.meeting_time;
      const meetingDateTime = new Date(`${m.meeting_date}T${timeStr}`);
      const isUpcoming = meetingDateTime >= now;

      const meetingObj = {
        ...m,
        is_upcoming: isUpcoming,
        formatted_date: m.meeting_date,
        formatted_time: m.meeting_time.substring(0, 5) // HH:mm
      };

      if (isUpcoming) {
        upcoming.push(meetingObj);
      } else {
        past.push(meetingObj);
      }
    });

    // Past meetings sorted in reverse chronological order
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
 * Get single meeting by ID
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
        u.avatar_color AS creator_avatar
      FROM meetings m
      JOIN users u ON m.created_by = u.id
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
 * Create a new meeting.
 * Body: { title, agenda, description, meeting_link, meeting_date, meeting_time }
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
      meetingTime
    } = req.body;

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
        message: 'Meeting start time (HH:mm) is required.'
      });
    }

    // Clean and validate time format HH:mm or HH:mm:ss
    let cleanTime = mTime;
    if (cleanTime.length === 5) {
      cleanTime = `${cleanTime}:00`;
    }

    const rawAgenda = description !== undefined ? description : agenda;
    const cleanAgenda = rawAgenda && rawAgenda.trim() ? rawAgenda.trim() : null;

    const rawLink = meeting_link !== undefined ? meeting_link : meetingLink;
    const cleanLink = rawLink && rawLink.trim() ? rawLink.trim() : null;

    const [result] = await pool.query(
      'INSERT INTO meetings (created_by, title, agenda, meeting_link, meeting_date, meeting_time) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, title.trim(), cleanAgenda, cleanLink, mDate, cleanTime]
    );

    const newMeetingId = result.insertId;

    const [rows] = await pool.query(
      `SELECT 
        m.id,
        m.created_by,
        m.title,
        m.agenda,
        m.agenda AS description,
        m.meeting_link,
        m.meeting_date,
        m.meeting_time,
        m.created_at,
        u.full_name AS creator_name,
        u.email AS creator_email,
        u.avatar_color AS creator_avatar
      FROM meetings m
      JOIN users u ON m.created_by = u.id
      WHERE m.id = ?`,
      [newMeetingId]
    );

    return res.status(201).json({
      success: true,
      message: 'Meeting organized successfully.',
      meeting: rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/meetings/:id
 * Edit meeting. Enforces backend ownership: creator only.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    if (isNaN(meetingId)) {
      return res.status(400).json({ success: false, message: 'Invalid meeting ID.' });
    }

    const [existing] = await pool.query('SELECT created_by FROM meetings WHERE id = ?', [meetingId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }

    if (existing[0].created_by !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You can only edit meetings you organized.'
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
        message: 'Meeting start time (HH:mm) is required.'
      });
    }

    let cleanTime = mTime;
    if (cleanTime.length === 5) {
      cleanTime = `${cleanTime}:00`;
    }

    const rawAgenda = description !== undefined ? description : agenda;
    const cleanAgenda = rawAgenda && rawAgenda.trim() ? rawAgenda.trim() : null;

    const rawLink = meeting_link !== undefined ? meeting_link : meetingLink;
    const cleanLink = rawLink && rawLink.trim() ? rawLink.trim() : null;

    await pool.query(
      'UPDATE meetings SET title = ?, agenda = ?, meeting_link = ?, meeting_date = ?, meeting_time = ? WHERE id = ?',
      [title.trim(), cleanAgenda, cleanLink, mDate, cleanTime, meetingId]
    );

    const [rows] = await pool.query(
      `SELECT 
        m.id,
        m.created_by,
        m.title,
        m.agenda,
        m.agenda AS description,
        m.meeting_link,
        m.meeting_date,
        m.meeting_time,
        m.created_at,
        u.full_name AS creator_name,
        u.email AS creator_email,
        u.avatar_color AS creator_avatar
      FROM meetings m
      JOIN users u ON m.created_by = u.id
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
 * Delete meeting. Enforces backend ownership: creator only.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    if (isNaN(meetingId)) {
      return res.status(400).json({ success: false, message: 'Invalid meeting ID.' });
    }

    const [existing] = await pool.query('SELECT created_by, title FROM meetings WHERE id = ?', [meetingId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }

    if (existing[0].created_by !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You can only delete meetings you organized.'
      });
    }

    await pool.query('DELETE FROM meetings WHERE id = ?', [meetingId]);

    return res.status(200).json({
      success: true,
      message: `Meeting "${existing[0].title}" deleted successfully.`
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
