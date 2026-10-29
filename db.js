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

// Ensure tables exist on startup (auto-migration for both local and cloud databases)
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

    // 2. Ensure groups table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`groups\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`name\` VARCHAR(150) NOT NULL,
        \`description\` TEXT NULL,
        \`created_by\` INT NOT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_groups_creator\` (\`created_by\`),
        CONSTRAINT \`fk_groups_creator\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. Ensure group_members table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`group_members\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`group_id\` INT NOT NULL,
        \`user_id\` INT NOT NULL,
        \`role\` ENUM('Admin', 'Member') NOT NULL DEFAULT 'Member',
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_gm_group\` (\`group_id\`),
        INDEX \`idx_gm_user\` (\`user_id\`),
        UNIQUE KEY \`uk_group_user\` (\`group_id\`, \`user_id\`),
        CONSTRAINT \`fk_gm_group\` FOREIGN KEY (\`group_id\`) REFERENCES \`groups\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`fk_gm_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Ensure tasks table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`tasks\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` INT NOT NULL,
        \`group_id\` INT NULL,
        \`assigned_by\` INT NULL,
        \`title\` VARCHAR(255) NOT NULL,
        \`description\` TEXT NULL,
        \`task_date\` DATE NOT NULL,
        \`status\` ENUM('Pending', 'In Progress', 'Completed') NOT NULL DEFAULT 'Pending',
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_tasks_date\` (\`task_date\`),
        INDEX \`idx_tasks_status\` (\`status\`),
        INDEX \`idx_tasks_user_id\` (\`user_id\`),
        INDEX \`idx_tasks_group_id\` (\`group_id\`),
        CONSTRAINT \`fk_tasks_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Auto-migrate tasks columns if table already existed
    try {
      const [taskCols] = await connection.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks' AND COLUMN_NAME IN ('group_id', 'assigned_by')`,
        [dbName]
      );
      const existingNames = taskCols.map(c => c.COLUMN_NAME);
      if (!existingNames.includes('group_id')) {
        await connection.query('ALTER TABLE `tasks` ADD COLUMN `group_id` INT NULL AFTER `user_id`, ADD INDEX `idx_tasks_group_id` (`group_id`)');
        console.log('[Database] Migrated tasks table: added group_id column');
      }
      if (!existingNames.includes('assigned_by')) {
        await connection.query('ALTER TABLE `tasks` ADD COLUMN `assigned_by` INT NULL AFTER `group_id`');
        console.log('[Database] Migrated tasks table: added assigned_by column');
      }
    } catch (tErr) {
      console.warn('[Database] Task migration check:', tErr.message);
    }

    // 5. Ensure meetings table exists with meeting_link and group_id
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`meetings\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`created_by\` INT NOT NULL,
        \`group_id\` INT NULL,
        \`title\` VARCHAR(255) NOT NULL,
        \`agenda\` TEXT NULL,
        \`meeting_link\` TEXT NULL,
        \`meeting_date\` DATE NOT NULL,
        \`meeting_time\` TIME NOT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_meetings_date_time\` (\`meeting_date\`, \`meeting_time\`),
        INDEX \`idx_meetings_creator\` (\`created_by\`),
        INDEX \`idx_meetings_group_id\` (\`group_id\`),
        CONSTRAINT \`fk_meetings_creator\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Auto-migrate meetings columns if table already existed
    try {
      const [meetCols] = await connection.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'meetings' AND COLUMN_NAME IN ('meeting_link', 'group_id')`,
        [dbName]
      );
      const existingMeetNames = meetCols.map(c => c.COLUMN_NAME);
      if (!existingMeetNames.includes('meeting_link')) {
        await connection.query('ALTER TABLE `meetings` ADD COLUMN `meeting_link` TEXT NULL AFTER `agenda`');
        console.log('[Database] Migrated meetings: added meeting_link column');
      }
      if (!existingMeetNames.includes('group_id')) {
        await connection.query('ALTER TABLE `meetings` ADD COLUMN `group_id` INT NULL AFTER `created_by`, ADD INDEX `idx_meetings_group_id` (`group_id`)');
        console.log('[Database] Migrated meetings: added group_id column');
      }
    } catch (mErr) {
      console.warn('[Database] Meetings migration check:', mErr.message);
    }

    // 6. Ensure app_settings exists
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
