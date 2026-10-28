const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env') });

// Determine connection options (supports local XAMPP or TiDB/Cloud SSL MySQL)
function buildPoolConfig() {
  const isCloudOrSsl = 
    process.env.DB_SSL === 'true' || 
    (process.env.DB_HOST && process.env.DB_HOST.includes('tidbcloud')) ||
    (process.env.DB_PORT && parseInt(process.env.DB_PORT, 10) === 4000);

  const baseConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
    database: process.env.DB_NAME || 'group_work_db',
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    dateStrings: true
  };

  if (isCloudOrSsl) {
    baseConfig.ssl = {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true
    };
  }

  return baseConfig;
}

// MySQL Connection Pool Configuration
const pool = mysql.createPool(buildPoolConfig());

// Ensure tables exist on startup (auto-migration for both local and new cloud databases)
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    const dbName = process.env.DB_NAME || 'group_work_db';
    console.log(`[Database] Successfully connected to MySQL database "${dbName}" at ${process.env.DB_HOST || '127.0.0.1'}`);

    // 1. Ensure users table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`users\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`full_name\` VARCHAR(100) NOT NULL,
        \`email\` VARCHAR(150) NOT NULL UNIQUE,
        \`password_hash\` VARCHAR(255) NOT NULL,
        \`avatar_color\` VARCHAR(10) DEFAULT '#3157D5',
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_users_email\` (\`email\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Ensure tasks table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`tasks\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` INT NOT NULL,
        \`title\` VARCHAR(255) NOT NULL,
        \`description\` TEXT NULL,
        \`task_date\` DATE NOT NULL,
        \`status\` ENUM('Pending', 'In Progress', 'Completed') NOT NULL DEFAULT 'Pending',
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_tasks_date\` (\`task_date\`),
        INDEX \`idx_tasks_status\` (\`status\`),
        INDEX \`idx_tasks_user_id\` (\`user_id\`),
        CONSTRAINT \`fk_tasks_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. Ensure meetings table exists with meeting_link
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`meetings\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`created_by\` INT NOT NULL,
        \`title\` VARCHAR(255) NOT NULL,
        \`agenda\` TEXT NULL,
        \`meeting_link\` TEXT NULL,
        \`meeting_date\` DATE NOT NULL,
        \`meeting_time\` TIME NOT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_meetings_date_time\` (\`meeting_date\`, \`meeting_time\`),
        INDEX \`idx_meetings_creator\` (\`created_by\`),
        CONSTRAINT \`fk_meetings_creator\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Check meeting_link column if table already existed prior to migration
    try {
      const [cols] = await connection.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'meetings' AND COLUMN_NAME = 'meeting_link'`,
        [dbName]
      );
      if (cols.length === 0) {
        await connection.query('ALTER TABLE `meetings` ADD COLUMN `meeting_link` TEXT NULL AFTER `agenda`');
        console.log('[Database] Automatically migrated schema: added "meeting_link" column to "meetings" table.');
      }
    } catch (_) {}

    // 4. Ensure app_settings exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`app_settings\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`setting_key\` VARCHAR(100) NOT NULL UNIQUE,
        \`setting_value\` TEXT NULL,
        \`description\` VARCHAR(255) NULL,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    connection.release();
    return true;
  } catch (error) {
    console.error('[Database] Connection Failed:', error.message);
    return false;
  }
}

module.exports = {
  pool,
  testConnection
};
