const mysql = require('mysql2/promise');

async function testTiDB() {
  console.log('Testing TiDB Cloud connection...');
  try {
    const connection = await mysql.createConnection({
      host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
      port: 4000,
      user: '28iu97LaNB6G2pE.root',
      password: 'vaFI6oG1BPW4kzik',
      ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
      }
    });

    console.log('Connected to TiDB successfully!');
    const [rows] = await connection.query('SELECT VERSION() AS version');
    console.log('TiDB Version:', rows[0].version);

    // Create database group_work_db
    await connection.query('CREATE DATABASE IF NOT EXISTS \`group_work_db\`');
    console.log('Database group_work_db created or verified.');

    await connection.end();
    console.log('All tests passed!');
  } catch (err) {
    console.error('Error connecting to TiDB:', err.message);
  }
}

testTiDB();

