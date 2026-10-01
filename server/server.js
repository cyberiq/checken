const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { initializeDatabase, get, all, run } = require('./db');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'checken-super-secret-key';

app.use(cors());
app.use(express.json());

async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'غير مصرح' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await get('SELECT id, username, full_name, role, is_active FROM users WHERE id = ?', [decoded.userId]);
    if (!user || user.is_active !== 1) {
      return res.status(401).json({ message: 'المستخدم غير موجود أو غير نشط' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'رمز غير صالح' });
  }
}

function roleFilter(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'ليس لديك صلاحية المدير' });
  }
  next();
}

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', message: 'Checken API is running' });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, role } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ message: 'اسم المستخدم وكلمة المرور مطلوبان' });
  }

  const user = await get('SELECT * FROM users WHERE username = ? AND role = ?', [username.trim(), role || 'admin']);
  if (!user) {
    return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
    },
  });
});

app.get('/api/users', authenticateUser, roleFilter, async (_, res) => {
  const users = await all('SELECT id, username, full_name, role, created_at, is_active FROM users ORDER BY id DESC');
  res.json(users);
});

app.post('/api/users', authenticateUser, roleFilter, async (req, res) => {
  const { username, password, fullName, role } = req.body || {};

  if (!username || !password || !fullName) {
    return res.status(400).json({ message: 'البيانات مطلوبة' });
  }

  const existing = await get('SELECT id FROM users WHERE username = ?', [username.trim()]);
  if (existing) {
    return res.status(409).json({ message: 'اسم المستخدم موجود بالفعل' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await run(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
    [username.trim(), passwordHash, fullName.trim(), role || 'owner']
  );

  res.status(201).json({ id: result.id, message: 'تم إنشاء المستخدم' });
});

app.get('/api/fields', authenticateUser, async (req, res) => {
  const rows = await all(`
    SELECT f.*, u.full_name as owner_name
    FROM fields f
    LEFT JOIN users u ON u.id = f.owner_id
    WHERE (? = 'admin' OR f.owner_id = ?)
    ORDER BY f.id DESC
  `, [req.user.role, req.user.id]);

  res.json(rows);
});

app.post('/api/fields', authenticateUser, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ message: 'لا توجد صلاحية لإنشاء حقل' });
  }

  const {
    name,
    address,
    latitude,
    longitude,
    size,
    startDate,
    endDate,
    serial,
    cardCode,
    notes,
  } = req.body || {};

  if (!name || !address || !latitude || !longitude) {
    return res.status(400).json({ message: 'اسم الحقل والعنوان والإحداثيات مطلوبة' });
  }

  const ownerId = req.user.role === 'admin' ? (req.body.ownerId || null) : req.user.id;
  const fieldSerial = serial || `SER-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const fieldCode = cardCode || `CARD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const insertResult = await run(
    `INSERT INTO fields (name, address, latitude, longitude, size, start_date, end_date, owner_id, serial, card_code, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name.trim(),
      address.trim(),
      Number(latitude),
      Number(longitude),
      size || '2000 م²',
      startDate || new Date().toISOString().slice(0, 10),
      endDate || new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
      ownerId,
      fieldSerial,
      fieldCode,
      'نشط',
      notes || 'تمت إضافة الحقل عبر API',
    ]
  );

  res.status(201).json({ id: insertResult.id, message: 'تم تسجيل الحقل' });
});

app.get('/api/alerts', authenticateUser, async (req, res) => {
  const rows = await all(`
    SELECT a.*, f.name as field_name
    FROM alerts a
    LEFT JOIN fields f ON f.id = a.field_id
    WHERE (? = 'admin' OR f.owner_id = ?)
    ORDER BY a.id DESC
  `, [req.user.role, req.user.id]);

  res.json(rows);
});

app.post('/api/alerts', authenticateUser, async (req, res) => {
  const { fieldId, title, message, severity } = req.body || {};

  if (!title || !message) {
    return res.status(400).json({ message: 'عنوان التنبيه والنص مطلوبان' });
  }

  await run(
    'INSERT INTO alerts (field_id, title, message, severity) VALUES (?, ?, ?, ?)',
    [fieldId || null, title.trim(), message.trim(), severity || 'معلومة']
  );

  res.status(201).json({ message: 'تم حفظ التنبيه' });
});

app.get('/api/dashboard', authenticateUser, async (req, res) => {
  const [userCount, fieldCount, alertCount] = await Promise.all([
    get('SELECT COUNT(*) as count FROM users'),
    get('SELECT COUNT(*) as count FROM fields'),
    get('SELECT COUNT(*) as count FROM alerts'),
  ]);

  const fields = await all(`
    SELECT f.*, u.full_name as owner_name
    FROM fields f
    LEFT JOIN users u ON u.id = f.owner_id
    WHERE (? = 'admin' OR f.owner_id = ?)
    ORDER BY f.id DESC
  `, [req.user.role, req.user.id]);

  const fieldSummaries = await Promise.all(fields.map(async (field) => {
    const latest = await get(`
      SELECT nh3, o2, temp, humidity, created_at
      FROM sensor_readings
      WHERE field_id = ?
      ORDER BY id DESC
      LIMIT 1
    `, [field.id]);

    return {
      ...field,
      latestReading: latest || { nh3: 0, o2: 0, temp: 0, humidity: 0 },
    };
  }));

  res.json({
    stats: {
      users: userCount.count,
      fields: fieldCount.count,
      alerts: alertCount.count,
      role: req.user.role,
    },
    fields: fieldSummaries,
  });
});

app.get('/api/fields/:id', authenticateUser, async (req, res) => {
  const field = await get(`
    SELECT f.*, u.full_name as owner_name
    FROM fields f
    LEFT JOIN users u ON u.id = f.owner_id
    WHERE f.id = ?
  `, [req.params.id]);

  if (!field) {
    return res.status(404).json({ message: 'الحقل غير موجود' });
  }

  if (req.user.role !== 'admin' && field.owner_id !== req.user.id) {
    return res.status(403).json({ message: 'ليس لديك صلاحية الوصول إلى هذا الحقل' });
  }

  const latestReading = await get(`
    SELECT nh3, o2, temp, humidity, device_id, created_at
    FROM sensor_readings
    WHERE field_id = ?
    ORDER BY id DESC
    LIMIT 1
  `, [field.id]);

  const alerts = await all(`
    SELECT * FROM alerts WHERE field_id = ? ORDER BY id DESC LIMIT 10
  `, [field.id]);

  const maintenance = await all(`
    SELECT * FROM maintenance_tasks WHERE field_id = ? ORDER BY id DESC LIMIT 10
  `, [field.id]);

  res.json({
    ...field,
    latestReading: latestReading || { nh3: 0, o2: 0, temp: 0, humidity: 0 },
    alerts,
    maintenance,
  });
});

app.post('/api/esp32/update', async (req, res) => {
  const { fieldId, deviceId, nh3, o2, temp, humidity } = req.body || {};

  if (!fieldId || !deviceId) {
    return res.status(400).json({ message: 'معرف الحقل والجهاز مطلوبان' });
  }

  await run(
    `INSERT INTO sensor_readings (field_id, device_id, nh3, o2, temp, humidity)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [Number(fieldId), deviceId, Number(nh3 || 0), Number(o2 || 0), Number(temp || 0), Number(humidity || 0)]
  );

  res.status(201).json({ message: 'تمت تحديث بيانات ESP32 بنجاح' });
});

app.get('/api/esp32/latest/:fieldId', async (req, res) => {
  const latest = await get(`
    SELECT field_id, device_id, nh3, o2, temp, humidity, created_at
    FROM sensor_readings
    WHERE field_id = ?
    ORDER BY id DESC LIMIT 1
  `, [req.params.fieldId]);

  if (!latest) {
    return res.status(404).json({ message: 'لا توجد قراءات لهذا الحقل' });
  }

  res.json(latest);
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database init failed:', error);
    process.exit(1);
  });

module.exports = app;
