const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const { DB_PATH } = process.env;

const dbDirectory = path.dirname(DB_PATH || path.join(__dirname, 'data', 'poultry.db'));
if (!fs.existsSync(dbDirectory)) {
  fs.mkdirSync(dbDirectory, { recursive: true });
}

const db = new sqlite3.Database(path.resolve(DB_PATH || path.join(__dirname, 'data', 'poultry.db')));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER DEFAULT 1
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      size TEXT,
      start_date TEXT,
      end_date TEXT,
      owner_id INTEGER,
      serial TEXT UNIQUE,
      card_code TEXT UNIQUE,
      status TEXT DEFAULT 'Active',
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(owner_id) REFERENCES users(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_id INTEGER,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT DEFAULT 'Info',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(field_id) REFERENCES fields(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sensor_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_id INTEGER,
      device_id TEXT,
      nh3 REAL,
      o2 REAL,
      temp REAL,
      humidity REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(field_id) REFERENCES fields(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS maintenance_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_id INTEGER,
      task_name TEXT NOT NULL,
      technician TEXT,
      scheduled_date TEXT,
      status TEXT DEFAULT 'Completed',
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(field_id) REFERENCES fields(id)
    );
  `);

  const defaultRoles = ['admin', 'owner'];
  for (const roleName of defaultRoles) {
    const existingRole = await get('SELECT id FROM roles WHERE name = ?', [roleName]);
    if (!existingRole) {
      await run('INSERT INTO roles (name, description) VALUES (?, ?)', [
        roleName,
        roleName === 'admin' ? 'System Administrator' : 'Field Owner',
      ]);
    }
  }

  const adminExists = await get('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!adminExists) {
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash('admin123', 10);
    await run(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      ['admin', passwordHash, 'مدير النظام', 'admin']
    );
  }

  const ownerExists = await get('SELECT id FROM users WHERE username = ?', ['owner']);
  if (!ownerExists) {
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash('owner123', 10);
    await run(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      ['owner', passwordHash, 'صاحب الحقل', 'owner']
    );
  }

  const fieldCount = await get('SELECT COUNT(*) as count FROM fields');
  if ((fieldCount?.count ?? 0) === 0) {
    const owner = await get('SELECT id FROM users WHERE username = ?', ['owner']);
    if (owner) {
      const fieldId = await run(
        `INSERT INTO fields (name, address, latitude, longitude, size, start_date, end_date, owner_id, serial, card_code, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'Rawdah Field',
          'Riyadh - Rawdah District',
          24.7136,
          46.6753,
          '2500 m²',
          '2026-01-01',
          '2026-12-31',
          owner.id,
          'SER-AL-001',
          'CARD-AL-001',
          'Active',
          'Sample field from the live database',
        ]
      );

      await run(
        `INSERT INTO sensor_readings (field_id, device_id, nh3, o2, temp, humidity)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [fieldId.id, 'ESP32-001', 8.2, 21.4, 28.6, 61.4]
      );

      await run(
        `INSERT INTO alerts (field_id, title, message, severity)
         VALUES (?, ?, ?, ?)`,
        [fieldId.id, 'Periodic Alert', 'Field data was updated automatically every 10 minutes.', 'Info']
      );

      await run(
        `INSERT INTO maintenance_tasks (field_id, task_name, technician, scheduled_date, status, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [fieldId.id, 'Ammonia Sensor Cleaning', 'Ahmed', '2026-10-05', 'Completed', 'Calibration completed successfully']
      );
    }
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  initializeDatabase,
};
