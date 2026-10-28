const { pool } = require('./db');

async function migrate() {
  try {
    console.log('Connecting to database...');
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'group_work_db' AND TABLE_NAME = 'meetings'`
    );
    console.log('Existing columns in meetings:', cols.map(c => c.COLUMN_NAME));
    
    const hasLink = cols.some(c => c.COLUMN_NAME === 'meeting_link');
    if (!hasLink) {
      await pool.query('ALTER TABLE meetings ADD COLUMN meeting_link TEXT NULL AFTER agenda');
      console.log('SUCCESS: Added "meeting_link" column to "meetings" table.');
    } else {
      console.log('Column "meeting_link" already exists in "meetings" table.');
    }

    // Check existing meetings
    const [meetings] = await pool.query('SELECT id, title, agenda, meeting_link FROM meetings');
    console.log('Current meetings count:', meetings.length);
    console.log('Current meetings:', JSON.stringify(meetings, null, 2));

    // If there is an existing meeting without meeting_link (like "WAT"), we can update it or leave it
    if (meetings.length > 0 && !meetings[0].meeting_link) {
      console.log(`Note: Meeting id ${meetings[0].id} ("${meetings[0].title}") has null meeting_link.`);
    }

    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  }
}

migrate();

