const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables reliably from backend directory
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { testConnection, pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors({
  origin: '*', // Allow Flutter web, emulator (10.0.2.2), and physical device LAN access
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request Logger (Development)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Root information endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'Group Work Management API',
    version: '1.0.0',
    documentation: '/api/health',
    status: 'Running'
  });
});

// Health-check endpoint: verifies backend and XAMPP MySQL connectivity
app.get('/api/health', async (req, res) => {
  try {
    const startTime = Date.now();
    const [rows] = await pool.query('SELECT 1 + 1 AS result');
    const latency = Date.now() - startTime;

    res.status(200).json({
      status: 'OK',
      message: 'Group Work Management API and MySQL Database are healthy.',
      database: 'connected',
      db_test_result: rows[0].result,
      db_latency_ms: latency,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      port: PORT
    });
  } catch (error) {
    console.error('[Health Check Failed]:', error.message);
    res.status(503).json({
      status: 'ERROR',
      message: 'Database connection failed. Ensure XAMPP MySQL is started.',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Mount modular routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/team', require('./routes/team'));
app.use('/api/meetings', require('./routes/meetings'));
app.use('/api/summary', require('./routes/summary'));
app.use('/api/groups', require('./routes/groups'));

// 404 Handler for undefined API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint ${req.method} ${req.originalUrl} not found.`
  });
});

// Centralized Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]:', err);

  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Start Server & verify database connection
async function startServer() {
  const dbConnected = await testConnection();
  if (!dbConnected) {
    console.warn('[Warning] MySQL connection could not be established. Make sure XAMPP MySQL is running.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 Group Work Management Backend Server`);
    console.log(`📡 Local URL:             http://localhost:${PORT}`);
    console.log(`📱 Android Emulator URL:  http://10.0.2.2:${PORT}`);
    console.log(`🩺 Health Check:          http://localhost:${PORT}/api/health`);
    console.log(`====================================================`);
  });
}

startServer();
