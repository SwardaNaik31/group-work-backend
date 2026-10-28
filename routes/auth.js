const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const authenticateToken = require('../middleware/auth');

// Palette of curated avatar colors for team members
const AVATAR_COLORS = [
  '#3157D5', // Primary Blue
  '#10B981', // Emerald Green
  '#F59E0B', // Amber
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316', // Orange
  '#6366F1'  // Indigo
];

function pickAvatarColor(name) {
  if (!name) return AVATAR_COLORS[0];
  let sum = 0;
  for (let i = 0; i < name.length; i++) {
    sum += name.charCodeAt(i);
  }
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

/**
 * POST /api/auth/register
 * Body: { full_name, email, password, confirm_password }
 */
router.post('/register', async (req, res, next) => {
  try {
    const { full_name, email, password, confirm_password } = req.body;

    // 1. Validation
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Full name is required.'
      });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email address is required.'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address.'
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long.'
      });
    }

    if (password !== confirm_password) {
      return res.status(400).json({
        success: false,
        message: 'Passwords do not match.'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cleanFullName = full_name.trim();

    // 2. Prevent duplicate email registration
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = ?',
      [normalizedEmail]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email address already exists.'
      });
    }

    // 3. Hash password using bcryptjs
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const avatarColor = pickAvatarColor(cleanFullName);

    // 4. Insert into database
    const [result] = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)',
      [cleanFullName, normalizedEmail, passwordHash, avatarColor]
    );

    const userId = result.insertId;

    // 5. Generate JWT token
    const tokenPayload = {
      id: userId,
      email: normalizedEmail,
      full_name: cleanFullName
    };

    const secret = process.env.JWT_SECRET || 'group_work_management_super_secret_jwt_key_2026_xyz123';
    const expiresIn = process.env.JWT_EXPIRES_IN || '30d';
    const token = jwt.sign(tokenPayload, secret, { expiresIn });

    return res.status(201).json({
      success: true,
      message: 'Registration successful! Welcome to the group workspace.',
      token,
      user: {
        id: userId,
        full_name: cleanFullName,
        email: normalizedEmail,
        avatar_color: avatarColor,
        created_at: new Date().toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Find user
    const [rows] = await pool.query(
      'SELECT id, full_name, email, password_hash, avatar_color, created_at FROM users WHERE LOWER(email) = ?',
      [normalizedEmail]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    const user = rows[0];

    // Check password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    // Generate JWT token
    const tokenPayload = {
      id: user.id,
      email: user.email,
      full_name: user.full_name
    };

    const secret = process.env.JWT_SECRET || 'group_work_management_super_secret_jwt_key_2026_xyz123';
    const expiresIn = process.env.JWT_EXPIRES_IN || '30d';
    const token = jwt.sign(tokenPayload, secret, { expiresIn });

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        avatar_color: user.avatar_color,
        created_at: user.created_at
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/me
 * Protected endpoint to fetch current authenticated user profile
 */
router.get('/me', authenticateToken, (req, res) => {
  return res.status(200).json({
    success: true,
    user: req.user
  });
});

module.exports = router;
