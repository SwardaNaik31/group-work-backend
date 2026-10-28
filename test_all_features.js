const http = require('http');
const { pool } = require('./db');
const jwt = require('jsonwebtoken');

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runAllTests() {
  console.log('=== STARTING FULL END-TO-END VERIFICATION ===\n');

  // 1. Get test user
  const [users] = await pool.query('SELECT id, full_name, email FROM users LIMIT 1');
  if (users.length === 0) {
    console.error('No users in DB');
    process.exit(1);
  }
  const user = users[0];
  const token = jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET || 'group_work_management_super_secret_jwt_key_2026_xyz123',
    { expiresIn: '1d' }
  );
  console.log(`✓ Authenticated as: ${user.full_name} (${user.email})\n`);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // ----------------------------------------------------
  // TEST 1: Create Meeting with Meeting Link
  // ----------------------------------------------------
  console.log('--- TEST 1: POST /api/meetings (Create with link) ---');
  const createMeetingRes = await request({
    hostname: '127.0.0.1',
    port: 4000,
    path: '/api/meetings',
    method: 'POST',
    headers
  }, {
    title: 'Automated Test Meeting',
    agenda: 'Testing meeting link, update, and delete',
    meeting_link: 'https://meet.google.com/test-e2e-sync',
    meeting_date: '2026-10-28',
    meeting_time: '19:00'
  });

  console.log('Status:', createMeetingRes.status);
  console.log('Created ID:', createMeetingRes.data.meeting?.id);
  console.log('Meeting Link:', createMeetingRes.data.meeting?.meeting_link);
  if (createMeetingRes.status !== 201 || !createMeetingRes.data.meeting?.meeting_link) {
    console.error('FAILED Test 1');
    process.exit(1);
  }
  const createdMeetingId = createMeetingRes.data.meeting.id;
  console.log('✓ TEST 1 PASSED: Meeting created with link successfully.\n');

  // ----------------------------------------------------
  // TEST 2: Update Meeting (Edit Meeting)
  // ----------------------------------------------------
  console.log('--- TEST 2: PUT /api/meetings/:id (Edit meeting) ---');
  const updateMeetingRes = await request({
    hostname: '127.0.0.1',
    port: 4000,
    path: `/api/meetings/${createdMeetingId}`,
    method: 'PUT',
    headers
  }, {
    title: 'Updated Test Meeting Title',
    agenda: 'Updated agenda description',
    meeting_link: 'https://zoom.us/j/9876543210',
    meeting_date: '2026-10-29',
    meeting_time: '20:00'
  });

  console.log('Status:', updateMeetingRes.status);
  console.log('Updated Title:', updateMeetingRes.data.meeting?.title);
  console.log('Updated Link:', updateMeetingRes.data.meeting?.meeting_link);
  if (updateMeetingRes.status !== 200 || updateMeetingRes.data.meeting?.title !== 'Updated Test Meeting Title') {
    console.error('FAILED Test 2');
    process.exit(1);
  }
  console.log('✓ TEST 2 PASSED: Meeting edited successfully.\n');

  // ----------------------------------------------------
  // TEST 3: Delete Meeting
  // ----------------------------------------------------
  console.log('--- TEST 3: DELETE /api/meetings/:id (Delete meeting) ---');
  const deleteMeetingRes = await request({
    hostname: '127.0.0.1',
    port: 4000,
    path: `/api/meetings/${createdMeetingId}`,
    method: 'DELETE',
    headers
  });

  console.log('Status:', deleteMeetingRes.status);
  console.log('Message:', deleteMeetingRes.data.message);
  if (deleteMeetingRes.status !== 200) {
    console.error('FAILED Test 3');
    process.exit(1);
  }
  console.log('✓ TEST 3 PASSED: Meeting deleted successfully.\n');

  // ----------------------------------------------------
  // TEST 4: Create, Update, Delete Task
  // ----------------------------------------------------
  console.log('--- TEST 4: Task lifecycle (POST, PUT, DELETE /api/tasks) ---');
  // 4a. Create task
  const createTaskRes = await request({
    hostname: '127.0.0.1',
    port: 4000,
    path: '/api/tasks',
    method: 'POST',
    headers
  }, {
    title: 'Automated Lifecycle Task',
    description: 'Testing task editing and deletion',
    task_date: '2026-10-28',
    status: 'Pending'
  });
  console.log('Create Task Status:', createTaskRes.status);
  const createdTaskId = createTaskRes.data.task?.id;

  // 4b. Update task
  const updateTaskRes = await request({
    hostname: '127.0.0.1',
    port: 4000,
    path: `/api/tasks/${createdTaskId}`,
    method: 'PUT',
    headers
  }, {
    title: 'Updated Task Title',
    description: 'Updated task description',
    task_date: '2026-10-28',
    status: 'In Progress'
  });
  console.log('Update Task Status:', updateTaskRes.status);

  // 4c. Delete task
  const deleteTaskRes = await request({
    hostname: '127.0.0.1',
    port: 4000,
    path: `/api/tasks/${createdTaskId}`,
    method: 'DELETE',
    headers
  });
  console.log('Delete Task Status:', deleteTaskRes.status);

  if (createTaskRes.status === 201 && updateTaskRes.status === 200 && deleteTaskRes.status === 200) {
    console.log('✓ TEST 4 PASSED: Task create, edit, delete lifecycle verified.\n');
  } else {
    console.error('FAILED Test 4');
    process.exit(1);
  }

  console.log('============================================');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
  console.log('============================================');
  process.exit(0);
}

runAllTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});

