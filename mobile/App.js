import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Speech from 'expo-speech';
import * as SQLite from 'expo-sqlite';
import * as Location from 'expo-location';

const DEFAULT_HOST = '192.168.1.30';
const DEFAULT_PORT = '81';
const API_BASE_URL = 'http://localhost:4000/api';

const createWebDatabase = () => {
  const STORAGE_KEY = 'poultry_monitor_web_db_v1';

  const readState = () => {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : { users: [], fields: [] };
    } catch (error) {
      return { users: [], fields: [] };
    }
  };

  const writeState = (state) => {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const nextId = (tableName) => {
    const state = readState();
    const rows = state[tableName] || [];
    return (rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1);
  };

  return {
    async execAsync() {
      return true;
    },
    async getFirstAsync(query, params = []) {
      const state = readState();
      if (query.includes('SELECT id FROM users WHERE username = ?')) {
        const username = params[0];
        return (state.users || []).find((user) => user.username === username) || null;
      }
      if (query.includes('SELECT COUNT(*) as count FROM fields')) {
        return { count: (state.fields || []).length };
      }
      if (query.includes('SELECT id FROM users WHERE username = ?')) {
        const username = params[0];
        return (state.users || []).find((user) => user.username === username) || null;
      }
      return null;
    },
    async getAllAsync(query) {
      const state = readState();
      if (query.includes('SELECT * FROM users ORDER BY id')) {
        return [...(state.users || [])].sort((a, b) => Number(a.id) - Number(b.id));
      }
      if (query.includes('SELECT * FROM fields ORDER BY id')) {
        return [...(state.fields || [])].sort((a, b) => Number(a.id) - Number(b.id));
      }
      return [];
    },
    async runAsync(query, params = []) {
      const state = readState();
      if (query.includes('INSERT INTO users')) {
        const [username, password, fullName, role, createdAt] = params;
        const row = { id: nextId('users'), username, password, fullName, role, createdAt };
        state.users = [...(state.users || []), row];
        writeState(state);
        return { lastInsertRowId: row.id, changes: 1 };
      }
      if (query.includes('INSERT INTO fields')) {
        const [name, address, latitude, longitude, size, startDate, endDate, ownerId, serial, cardCode, status, notes] = params;
        const row = { id: nextId('fields'), name, address, latitude, longitude, size, startDate, endDate, ownerId, serial, cardCode, status, notes };
        state.fields = [...(state.fields || []), row];
        writeState(state);
        return { lastInsertRowId: row.id, changes: 1 };
      }
      return { lastInsertRowId: 0, changes: 0 };
    },
  };
};

const db = Platform.OS === 'web' ? createWebDatabase() : SQLite.openDatabaseSync('poultry_monitor.db');

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const buildReading = (prev, variance, min, max) => {
  const next = prev + (Math.random() - 0.5) * variance;
  return Number(clamp(next, min, max).toFixed(1));
};

const getStatus = (sensorData) => {
  const isWarning =
    sensorData.nh3 > 10 ||
    sensorData.o2 < 20 ||
    sensorData.temp > 30 ||
    sensorData.humidity < 35 ||
    sensorData.humidity > 75;

  const isCritical =
    sensorData.nh3 > 20 ||
    sensorData.o2 < 19 ||
    sensorData.temp > 32 ||
    sensorData.humidity < 30 ||
    sensorData.humidity > 80;

  if (isCritical) return 'Critical';
  if (isWarning) return 'Warning';
  return 'Healthy';
};

const speakArabic = (text, rate = 0.8) => {
  Speech.stop();
  Speech.speak(text, {
    language: 'ar-SA',
    rate,
    pitch: 1.08,
  });
};

async function initializeDatabase() {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      fullName TEXT,
      role TEXT,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      address TEXT,
      latitude REAL,
      longitude REAL,
      size TEXT,
      startDate TEXT,
      endDate TEXT,
      ownerId INTEGER,
      serial TEXT,
      cardCode TEXT,
      status TEXT,
      notes TEXT
    );
  `);

  const adminExists = await db.getFirstAsync('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!adminExists) {
    await db.runAsync(
      'INSERT INTO users (username, password, fullName, role, createdAt) VALUES (?, ?, ?, ?, ?)',
      ['admin', 'admin123', 'مدير النظام', 'admin', new Date().toISOString()]
    );
  }

  const ownerExists = await db.getFirstAsync('SELECT id FROM users WHERE username = ?', ['owner']);
  if (!ownerExists) {
    await db.runAsync(
      'INSERT INTO users (username, password, fullName, role, createdAt) VALUES (?, ?, ?, ?, ?)',
      ['owner', 'owner123', 'صاحب الحقل', 'owner', new Date().toISOString()]
    );
  }

  const fieldCount = await db.getFirstAsync('SELECT COUNT(*) as count FROM fields');
  if ((fieldCount?.count ?? 0) === 0) {
    const ownerRow = await db.getFirstAsync('SELECT id FROM users WHERE username = ?', ['owner']);
    const ownerId = ownerRow?.id ?? 1;

    await db.runAsync(
      `INSERT INTO fields (name, address, latitude, longitude, size, startDate, endDate, ownerId, serial, cardCode, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'حقل الروضة',
        'الرياض - حي الروضة',
        24.7136,
        46.6753,
        '2500 م²',
        '2026-01-01',
        '2026-12-31',
        ownerId,
        'SER-AL-001',
        'CARD-AL-001',
        'نشط',
        'حقل تجريبي ببيانات فعليّة',
      ]
    );

    await db.runAsync(
      `INSERT INTO fields (name, address, latitude, longitude, size, startDate, endDate, ownerId, serial, cardCode, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'حقل النخيل',
        'جدة - حي النخيل',
        21.4858,
        39.1925,
        '4200 م²',
        '2026-02-01',
        '2026-11-30',
        ownerId,
        'SER-AL-002',
        'CARD-AL-002',
        'قيد الصيانة',
        'يحتاج إلى صيانة دورية',
      ]
    );
  }
}

export default function App() {
  const [users, setUsers] = useState([]);
  const [fields, setFields] = useState([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [token, setToken] = useState(null);
  const [fieldProfile, setFieldProfile] = useState(null);
  const [role, setRole] = useState('admin');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [host, setHost] = useState(DEFAULT_HOST);
  const [port, setPort] = useState(DEFAULT_PORT);
  const [activeView, setActiveView] = useState('dashboard');
  const [selectedFieldId, setSelectedFieldId] = useState(1);
  const [notifications, setNotifications] = useState([
    { id: 1, title: 'Periodic Alert', message: 'Field data was updated automatically every 10 minutes.', time: '08:00', severity: 'Info' },
    { id: 2, title: 'Humidity Change', message: 'Humidity threshold exceeded in one field.', time: '08:10', severity: 'Warning' },
  ]);
  const [connectionState, setConnectionState] = useState('Disconnected');
  const [isConnecting, setIsConnecting] = useState(false);
  const [sensorData, setSensorData] = useState({ nh3: 8.2, o2: 21.4, temp: 28.6, humidity: 61.4 });
  const [newUser, setNewUser] = useState({ username: '', password: '', fullName: '', role: 'owner' });
  const [newField, setNewField] = useState({
    name: '',
    address: '',
    latitude: '24.7136',
    longitude: '46.6753',
    size: '2000 م²',
    startDate: '2026-10-01',
    endDate: '2027-09-30',
  });

  const status = useMemo(() => getStatus(sensorData), [sensorData]);
  const currentField = fields.find((field) => field.id === selectedFieldId) || fields[0];
  const visibleFields = currentUser?.role === 'owner'
    ? fields.filter((field) => Number(field.ownerId ?? field.owner_id) === Number(currentUser.id))
    : fields;

  const refreshData = async () => {
    const rows = await db.getAllAsync('SELECT * FROM users ORDER BY id');
    const fieldRows = await db.getAllAsync('SELECT * FROM fields ORDER BY id');
    setUsers(rows);
    setFields(fieldRows);
    if (fieldRows.length > 0 && !fieldRows.some((field) => field.id === selectedFieldId)) {
      setSelectedFieldId(fieldRows[0].id);
    }
  };

  useEffect(() => {
    async function load() {
      try {
        await initializeDatabase();
        await refreshData();
      } catch (error) {
        Alert.alert('خطأ', 'تعذّر تهيئة قاعدة البيانات');
      }
    }

    load();
  }, []);

  useEffect(() => {
    if (authenticated && token && currentField?.id) {
      loadFieldProfile(currentField.id, token);
    }
  }, [authenticated, currentField, token]);

  useEffect(() => {
    if (!fields.length) return;
    const field = fields.find((item) => item.id === selectedFieldId) || fields[0];
    const latest = field?.latestReading || field?.reading || {};
    setSensorData({
      nh3: Number(latest.nh3 ?? (8.2 + (field.id % 3))),
      o2: Number(latest.o2 ?? (21.4 - field.id)),
      temp: Number(latest.temp ?? (28.6 + (field.id * 1.2))),
      humidity: Number(latest.humidity ?? (61.4 + (field.id * 2.5))),
    });
  }, [fields, selectedFieldId]);

  useEffect(() => {
    if (!authenticated || !currentUser) return undefined;

    const interval = setInterval(() => {
      setSensorData((prev) => ({
        nh3: buildReading(prev.nh3, 2.4, 0, 35),
        o2: buildReading(prev.o2, 1.4, 15, 25),
        temp: buildReading(prev.temp, 1.6, 18, 40),
        humidity: buildReading(prev.humidity, 6, 20, 90),
      }));

      const nextAlert = {
        id: Date.now(),
        title: status === 'Critical' ? 'Critical Alert' : status === 'Warning' ? 'Warning Alert' : 'Periodic Alert',
        message: `Field data was updated automatically every 10 minutes. Oxygen ${sensorData.o2.toFixed(1)}% and humidity ${sensorData.humidity.toFixed(1)}%.`,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        severity: status === 'Critical' ? 'Critical' : status === 'Warning' ? 'Warning' : 'Info',
      };

      setNotifications((prev) => [nextAlert, ...prev].slice(0, 6));
    }, 10000);

    return () => clearInterval(interval);
  }, [authenticated, currentUser, sensorData, status]);

  useEffect(() => {
    if (!authenticated || !currentUser) return;

    const isCritical =
      sensorData.nh3 > 20 ||
      sensorData.o2 < 19 ||
      sensorData.temp > 32 ||
      sensorData.humidity < 30 ||
      sensorData.humidity > 80;

    const message = `Current field status is ${status}. Oxygen ${sensorData.o2.toFixed(1)}%. Humidity ${sensorData.humidity.toFixed(1)}%.`;

    if (isCritical || status !== 'Healthy') {
      speakArabic(message, 0.72);
    }
  }, [authenticated, currentUser, sensorData, status]);

  useEffect(() => {
    if (!authenticated) {
      setConnectionState('غير متصل');
      return undefined;
    }

    if (token && currentField?.id) {
      fetch(`${API_BASE_URL}/esp32/latest/${currentField.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((response) => response.ok ? response.json() : null)
        .then((payload) => {
          if (payload) {
            setSensorData({
              nh3: Number(payload.nh3 || 0),
              o2: Number(payload.o2 || 0),
              temp: Number(payload.temp || 0),
              humidity: Number(payload.humidity || 0),
            });
          }
        })
        .catch(() => {});
    }

    const url = `ws://${host.trim() || DEFAULT_HOST}:${port.trim() || DEFAULT_PORT}`;
    setIsConnecting(true);
    setConnectionState('جاري الاتصال...');

    const ws = new WebSocket(url);

    ws.onopen = () => {
      setIsConnecting(false);
      setConnectionState('متصل بـ ESP32');
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const next = {
          nh3: Number(payload.nh3 ?? sensorData.nh3),
          o2: Number(payload.o2 ?? sensorData.o2),
          temp: Number(payload.temp ?? sensorData.temp),
          humidity: Number(payload.humidity ?? sensorData.humidity),
        };

        const normalized = {
          nh3: Number(clamp(next.nh3, 0, 35).toFixed(1)),
          o2: Number(clamp(next.o2, 0, 25).toFixed(1)),
          temp: Number(clamp(next.temp, 0, 45).toFixed(1)),
          humidity: Number(clamp(next.humidity, 0, 100).toFixed(1)),
        };

        setSensorData(normalized);

        if (token && currentField?.id) {
          fetch(`${API_BASE_URL}/esp32/update`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              fieldId: currentField.id,
              deviceId: 'ESP32-MOBILE-CLIENT',
              nh3: normalized.nh3,
              o2: normalized.o2,
              temp: normalized.temp,
              humidity: normalized.humidity,
            }),
          }).catch(() => {});
        }
      } catch (error) {
        setConnectionState('استلام بيانات غير صالح');
      }
    };

    ws.onerror = () => {
      setIsConnecting(false);
      setConnectionState('فشل الاتصال');
    };

    ws.onclose = () => {
      setIsConnecting(false);
      setConnectionState('غير متصل');
    };

    return () => {
      if (ws.readyState === 1) ws.close();
    };
  }, [authenticated, currentField, host, port, token]);

  const loadDashboardData = async (userToken) => {
    try {
      const response = await fetch(`${API_BASE_URL}/dashboard`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });

      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data.fields)) {
        setFields(data.fields);
        if (data.fields.length > 0) {
          setSelectedFieldId((prev) => prev || data.fields[0].id);
        }
      }
    } catch (error) {
      console.log('dashboard fetch failed:', error.message);
    }
  };

  const loadFieldProfile = async (fieldId, userToken) => {
    if (!fieldId || !userToken) return;

    try {
      const response = await fetch(`${API_BASE_URL}/fields/${fieldId}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });

      if (!response.ok) return;
      const data = await response.json();
      setFieldProfile(data);
    } catch (error) {
      console.log('field profile fetch failed:', error.message);
    }
  };

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      Alert.alert('خطأ', 'يرجى إدخال اسم المستخدم وكلمة المرور');
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, role }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'فشل تسجيل الدخول');
      }

      setToken(data.token);
      setCurrentUser(data.user);
      setAuthenticated(true);

      if (data.user?.role === 'admin') {
        const usersResponse = await fetch(`${API_BASE_URL}/users`, {
          headers: { Authorization: `Bearer ${data.token}` },
        });

        if (usersResponse.ok) {
          const usersData = await usersResponse.json();
          setUsers(usersData);
        }
      }

      await loadDashboardData(data.token);
      return;
    } catch (error) {
      console.log('API login failed, fallback to local demo:', error.message);
    }

    const matchedUser = users.find(
      (item) => item.username === username.trim() && item.password === password.trim() && item.role === role
    );

    if (!matchedUser) {
      Alert.alert('خطأ', 'اسم المستخدم أو كلمة المرور غير صحيحة لهذا الدور');
      return;
    }

    setCurrentUser(matchedUser);
    setAuthenticated(true);
    const firstField = fields.find((field) => field.ownerId === matchedUser.id) || fields[0];
    if (firstField) setSelectedFieldId(firstField.id);
  };

  const handleAddUser = async () => {
    if (!newUser.username || !newUser.password || !newUser.fullName) {
      Alert.alert('خطأ', 'يرجى تعبئة بيانات المستخدم كاملة');
      return;
    }

    if (token && currentUser?.role === 'admin') {
      try {
        const response = await fetch(`${API_BASE_URL}/users`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            username: newUser.username.trim(),
            password: newUser.password,
            fullName: newUser.fullName.trim(),
            role: newUser.role,
          }),
        });

        const body = await response.json();
        if (!response.ok) throw new Error(body.message || 'فشل إنشاء المستخدم');
        await loadDashboardData(token);
        setNewUser({ username: '', password: '', fullName: '', role: 'owner' });
        Alert.alert('تمت', 'تم إنشاء المستخدم بنجاح عبر الـ API');
        return;
      } catch (error) {
        Alert.alert('خطأ', error.message);
        return;
      }
    }

    const exists = users.some((item) => item.username === newUser.username);
    if (exists) {
      Alert.alert('خطأ', 'اسم المستخدم موجود مسبقًا');
      return;
    }

    await db.runAsync(
      'INSERT INTO users (username, password, fullName, role, createdAt) VALUES (?, ?, ?, ?, ?)',
      [newUser.username.trim(), newUser.password.trim(), newUser.fullName.trim(), newUser.role, new Date().toISOString()]
    );

    setNewUser({ username: '', password: '', fullName: '', role: 'owner' });
    await refreshData();
    Alert.alert('تمت', 'تمت إضافة المستخدم بنجاح');
  };

  const handleAddField = async () => {
    if (!newField.name || !newField.address || !newField.latitude || !newField.longitude) {
      Alert.alert('خطأ', 'يرجى إدخال اسم الحقل وعنوانه والإحداثيات');
      return;
    }

    if (token) {
      try {
        const response = await fetch(`${API_BASE_URL}/fields`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            name: newField.name.trim(),
            address: newField.address.trim(),
            latitude: Number(newField.latitude),
            longitude: Number(newField.longitude),
            size: newField.size.trim(),
            startDate: newField.startDate,
            endDate: newField.endDate,
            notes: 'تمت إضافة الحقل عبر التطبيق',
            ownerId: currentUser?.role === 'admin' ? (users.find((user) => user.role === 'owner')?.id ?? 1) : currentUser.id,
          }),
        });

        const body = await response.json();
        if (!response.ok) throw new Error(body.message || 'فشل تسجيل الحقل');

        await loadDashboardData(token);
        setNewField({
          name: '',
          address: '',
          latitude: '24.7136',
          longitude: '46.6753',
          size: '2000 م²',
          startDate: '2026-10-01',
          endDate: '2027-09-30',
        });

        Alert.alert('تمت', 'تم تسجيل الحقل بنجاح في قاعدة البيانات');
        return;
      } catch (error) {
        Alert.alert('خطأ', error.message);
        return;
      }
    }

    const ownerId = currentUser?.role === 'admin' ? (users.find((user) => user.role === 'owner')?.id ?? 1) : currentUser.id;

    await db.runAsync(
      `INSERT INTO fields (name, address, latitude, longitude, size, startDate, endDate, ownerId, serial, cardCode, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newField.name.trim(),
        newField.address.trim(),
        Number(newField.latitude),
        Number(newField.longitude),
        newField.size.trim(),
        newField.startDate,
        newField.endDate,
        ownerId,
        `SER-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        `CARD-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        'نشط',
        'تمت إضافة الحقل من خلال إدارة التطبيق',
      ]
    );

    setNewField({
      name: '',
      address: '',
      latitude: '24.7136',
      longitude: '46.6753',
      size: '2000 م²',
      startDate: '2026-10-01',
      endDate: '2027-09-30',
    });

    await refreshData();
    Alert.alert('تمت', 'تم تسجيل الحقل بنجاح في قاعدة البيانات');
  };

  const handleSpeakNow = () => {
    const message = `حالة الحقل ${currentField?.name ?? 'الحقل الحالي'}. الأوكسجين ${sensorData.o2.toFixed(1)} بالمئة. الرطوبة ${sensorData.humidity.toFixed(1)} بالمئة. الحرارة ${sensorData.temp.toFixed(1)} درجة.`;
    speakArabic(message, 0.8);
  };

  const openMap = async (field) => {
    const lat = Number(field?.latitude ?? field?.lat ?? 24.7136);
    const lng = Number(field?.longitude ?? field?.lng ?? 46.6753);
    const googleUrl = `https://www.google.com/maps?q=${lat},${lng}`;
    const osmUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=12/${lat}/${lng}`;

    try {
      await Linking.openURL(googleUrl);
    } catch (error) {
      await Linking.openURL(osmUrl);
    }
  };

  const metricCards = useMemo(
    () => [
      { label: 'الأوكسجين', value: `${sensorData.o2.toFixed(1)} %`, tint: '#46c5ff' },
      { label: 'الرطوبة', value: `${sensorData.humidity.toFixed(1)} %`, tint: '#4ade80' },
      { label: 'الحرارة', value: `${sensorData.temp.toFixed(1)} °C`, tint: '#fbbf24' },
      { label: 'NH3', value: `${sensorData.nh3.toFixed(1)} ppm`, tint: '#f87171' },
    ],
    [sensorData]
  );

  const dashboardStats = useMemo(
    () => [
      { label: 'إجمالي الحقول', value: `${fields.length}` },
      { label: 'إجمالي المستخدمين', value: `${users.length}` },
      { label: 'الإشعارات', value: `${notifications.length}` },
      { label: 'حالة الحقل', value: status },
    ],
    [fields.length, notifications.length, status, users.length]
  );

  const isOwnerRole = currentUser?.role === 'owner';
  const navTabs = [
    { key: 'dashboard', label: 'لوحة التحكم' },
    { key: 'fields', label: 'الحقول' },
    { key: 'alerts', label: 'الإشعارات' },
    { key: 'map', label: 'الخريطة' },
    ...(isOwnerRole ? [] : [{ key: 'users', label: 'المستخدمين' }]),
    ...(isOwnerRole ? [] : [{ key: 'addField', label: 'إضافة حقل' }]),
  ];

  const renderLogin = () => (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.loginContainer}>
        <View style={styles.loginCard}>
          <Text style={styles.loginTitle}>تسجيل الدخول</Text>
          <Text style={styles.loginSubtitle}>نظام مراقبة الحقول</Text>

          <View style={styles.roleRow}>
            <Pressable
              style={[styles.roleButton, role === 'admin' && styles.roleButtonActive]}
              onPress={() => setRole('admin')}
            >
              <Text style={styles.roleButtonText}>مدير</Text>
            </Pressable>
            <Pressable
              style={[styles.roleButton, role === 'owner' && styles.roleButtonActive]}
              onPress={() => setRole('owner')}
            >
              <Text style={styles.roleButtonText}>صاحب حقل</Text>
            </Pressable>
          </View>

          <TextInput style={styles.input} value={username} onChangeText={setUsername} placeholder="اسم المستخدم" placeholderTextColor="#8aa9bd" autoCapitalize="none" />
          <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="كلمة المرور" placeholderTextColor="#8aa9bd" secureTextEntry />

          <Text style={styles.hostTitle}>ESP32 IP Address</Text>
          <View style={styles.hostRow}>
            <TextInput style={[styles.input, styles.halfInput]} value={host} onChangeText={setHost} placeholder="192.168.1.30" placeholderTextColor="#8aa9bd" autoCapitalize="none" />
            <TextInput style={[styles.input, styles.halfInput]} value={port} onChangeText={setPort} placeholder="81" placeholderTextColor="#8aa9bd" keyboardType="numeric" />
          </View>

          <Pressable style={styles.loginButton} onPress={handleLogin}>
            <Text style={styles.loginButtonText}>دخول</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );

  const renderDashboard = () => (
    <View style={styles.pageWrap}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>لوحة التحكم</Text>
        <Text style={[styles.statusBadge, status === 'Healthy' ? styles.safe : status === 'Warning' ? styles.warning : styles.danger]}>{status}</Text>
      </View>

      <View style={styles.summaryGrid}>
        {dashboardStats.map((item) => (
          <View key={item.label} style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>{item.label}</Text>
            <Text style={styles.summaryValue}>{item.value}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sectionTitle}>مؤشرات الحقل الحالي</Text>
      <View style={styles.metricsGrid}>
        {metricCards.map((item) => (
          <View key={item.label} style={[styles.metricCard, { borderTopColor: item.tint }]}>
            <Text style={styles.metricLabel}>{item.label}</Text>
            <Text style={styles.metricValue}>{item.value}</Text>
          </View>
        ))}
      </View>

      {currentField && (
        <View style={styles.fieldInfoBox}>
          <Text style={styles.fieldInfoTitle}>{currentField.name}</Text>
          <Text style={styles.fieldInfoText}>العنوان: {currentField.address}</Text>
          <Text style={styles.fieldInfoText}>الإحداثيات: {currentField.latitude || currentField.lat}, {currentField.longitude || currentField.lng}</Text>
          <Text style={styles.fieldInfoText}>المساحة: {currentField.size}</Text>
          <Text style={styles.fieldInfoText}>بداية الاشتراك: {currentField.startDate || currentField.start_date}</Text>
          <Text style={styles.fieldInfoText}>نهاية الاشتراك: {currentField.endDate || currentField.end_date}</Text>
          <Text style={styles.fieldInfoText}>السيريال: {currentField.serial}</Text>
          <Text style={styles.fieldInfoText}>الكود: {currentField.cardCode || currentField.card_code}</Text>
          <Pressable style={styles.primaryButton} onPress={() => openMap(currentField)}>
            <Text style={styles.primaryButtonText}>فتح الخريطة</Text>
          </Pressable>
        </View>
      )}

      {currentUser?.role === 'owner' && fieldProfile && (
        <View style={styles.fieldInfoBox}>
          <Text style={styles.fieldInfoTitle}>ملف صاحب الحقل</Text>
          <Text style={styles.fieldInfoText}>اسم صاحب الحقل: {fieldProfile.owner_name || currentUser.fullName}</Text>
          <Text style={styles.fieldInfoText}>بداية الاشتراك: {fieldProfile.start_date}</Text>
          <Text style={styles.fieldInfoText}>نهاية الاشتراك: {fieldProfile.end_date}</Text>
          <Text style={styles.fieldInfoText}>السيريال: {fieldProfile.serial}</Text>
          <Text style={styles.fieldInfoText}>حالة الحقل: {fieldProfile.status}</Text>
        </View>
      )}
    </View>
  );

  const renderFields = () => (
    <View style={styles.pageWrap}>
      <Text style={styles.title}>قائمة الحقول</Text>
      {(visibleFields.length ? visibleFields : fields).map((field) => (
        <Pressable key={field.id} onPress={() => setSelectedFieldId(field.id)} style={[styles.fieldCard, field.id === selectedFieldId && styles.fieldCardSelected]}>
          <View>
            <Text style={styles.fieldCardTitle}>{field.name}</Text>
            <Text style={styles.fieldCardText}>{field.address}</Text>
            <Text style={styles.fieldCardText}>المساحة: {field.size}</Text>
          </View>
          <View>
            <Text style={styles.fieldCardCode}>{field.serial}</Text>
            <Text style={styles.fieldCardCode}>{field.status}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );

  const renderUsers = () => (
    <View style={styles.pageWrap}>
      <Text style={styles.title}>إدارة المستخدمين</Text>
      {users.map((item) => (
        <View key={item.id} style={styles.userCard}>
          <Text style={styles.fieldCardTitle}>{item.fullName}</Text>
          <Text style={styles.fieldCardText}>اسم المستخدم: {item.username}</Text>
          <Text style={styles.fieldCardText}>الدور: {item.role}</Text>
        </View>
      ))}

      <View style={styles.formCard}>
        <Text style={styles.sectionTitle}>إضافة مستخدم جديد</Text>
        <TextInput style={styles.input} value={newUser.fullName} onChangeText={(value) => setNewUser({ ...newUser, fullName: value })} placeholder="الاسم الكامل" placeholderTextColor="#8aa9bd" />
        <TextInput style={styles.input} value={newUser.username} onChangeText={(value) => setNewUser({ ...newUser, username: value })} placeholder="اسم المستخدم" placeholderTextColor="#8aa9bd" autoCapitalize="none" />
        <TextInput style={styles.input} value={newUser.password} onChangeText={(value) => setNewUser({ ...newUser, password: value })} placeholder="كلمة المرور" placeholderTextColor="#8aa9bd" secureTextEntry />
        <View style={styles.roleRow}>
          <Pressable style={[styles.roleButton, newUser.role === 'admin' && styles.roleButtonActive]} onPress={() => setNewUser({ ...newUser, role: 'admin' })}>
            <Text style={styles.roleButtonText}>مدير</Text>
          </Pressable>
          <Pressable style={[styles.roleButton, newUser.role === 'owner' && styles.roleButtonActive]} onPress={() => setNewUser({ ...newUser, role: 'owner' })}>
            <Text style={styles.roleButtonText}>صاحب حقل</Text>
          </Pressable>
        </View>
        <Pressable style={styles.primaryButton} onPress={handleAddUser}>
          <Text style={styles.primaryButtonText}>حفظ المستخدم</Text>
        </Pressable>
      </View>
    </View>
  );

  const renderAddField = () => (
    <View style={styles.pageWrap}>
      <Text style={styles.title}>إضافة حقل جديد</Text>
      <View style={styles.formCard}>
        <TextInput style={styles.input} value={newField.name} onChangeText={(value) => setNewField({ ...newField, name: value })} placeholder="اسم الحقل" placeholderTextColor="#8aa9bd" />
        <TextInput style={styles.input} value={newField.address} onChangeText={(value) => setNewField({ ...newField, address: value })} placeholder="عنوان الحقل" placeholderTextColor="#8aa9bd" />
        <TextInput style={styles.input} value={newField.latitude} onChangeText={(value) => setNewField({ ...newField, latitude: value })} placeholder="خط العرض" placeholderTextColor="#8aa9bd" keyboardType="numeric" />
        <TextInput style={styles.input} value={newField.longitude} onChangeText={(value) => setNewField({ ...newField, longitude: value })} placeholder="خط الطول" placeholderTextColor="#8aa9bd" keyboardType="numeric" />
        <TextInput style={styles.input} value={newField.size} onChangeText={(value) => setNewField({ ...newField, size: value })} placeholder="حجم الحقل" placeholderTextColor="#8aa9bd" />
        <TextInput style={styles.input} value={newField.startDate} onChangeText={(value) => setNewField({ ...newField, startDate: value })} placeholder="تاريخ البداية" placeholderTextColor="#8aa9bd" />
        <TextInput style={styles.input} value={newField.endDate} onChangeText={(value) => setNewField({ ...newField, endDate: value })} placeholder="تاريخ النهاية" placeholderTextColor="#8aa9bd" />
        <Pressable style={styles.primaryButton} onPress={handleAddField}>
          <Text style={styles.primaryButtonText}>حفظ الحقل</Text>
        </Pressable>
      </View>
    </View>
  );

  const renderAlerts = () => (
    <View style={styles.pageWrap}>
      <Text style={styles.title}>الإشعارات</Text>
      {notifications.map((item) => (
        <View key={item.id} style={styles.alertCard}>
          <Text style={styles.alertTitle}>{item.title}</Text>
          <Text style={styles.alertText}>{item.message}</Text>
          <View style={styles.alertMetaRow}>
            <Text style={styles.alertMeta}>{item.time}</Text>
            <Text style={styles.alertMeta}>{item.severity}</Text>
          </View>
        </View>
      ))}
    </View>
  );

  const renderMap = () => (
    <View style={styles.pageWrap}>
      <Text style={styles.title}>خريطة الحقول</Text>
      {(visibleFields.length ? visibleFields : fields).map((field) => (
        <View key={field.id} style={styles.mapCard}>
          <Text style={styles.fieldCardTitle}>{field.name}</Text>
          <Text style={styles.fieldCardText}>{field.address}</Text>
          <Text style={styles.fieldCardText}>الإحداثيات: {field.latitude}, {field.longitude}</Text>
          <Pressable style={styles.primaryButton} onPress={() => openMap(field)}>
            <Text style={styles.primaryButtonText}>فتح الخريطة</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );

  const renderCurrentView = () => {
    if (activeView === 'dashboard') return renderDashboard();
    if (activeView === 'fields') return renderFields();
    if (activeView === 'users') return renderUsers();
    if (activeView === 'addField') return renderAddField();
    if (activeView === 'alerts') return renderAlerts();
    if (activeView === 'map') return renderMap();
    return renderDashboard();
  };

  if (!authenticated || !currentUser) return renderLogin();

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.appShell}>
        <View style={styles.topHeader}>
          <Text style={styles.userInfo}>{currentUser.fullName}</Text>
          <Pressable onPress={() => {
            setAuthenticated(false);
            setCurrentUser(null);
          }}>
            <Text style={styles.logoutText}>خروج</Text>
          </Pressable>
        </View>

        <View style={styles.navRow}>
          {navTabs.map((tab) => (
            <Pressable key={tab.key} style={[styles.tabButton, activeView === tab.key && styles.tabButtonActive]} onPress={() => setActiveView(tab.key)}>
              <Text style={styles.tabText}>{tab.label}</Text>
            </Pressable>
          ))}
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          {renderCurrentView()}
        </ScrollView>

        <Pressable style={styles.actionButton} onPress={handleSpeakNow}>
          <Text style={styles.actionButtonText}>{isConnecting ? 'جاري الاتصال...' : 'تحدث الآن'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#061922' },
  appShell: { flex: 1, backgroundColor: '#061922' },
  topHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#0b2431',
    borderBottomWidth: 1,
    borderBottomColor: '#183b52',
  },
  userInfo: { color: '#edf9ff', fontSize: 16, fontWeight: '700' },
  logoutText: { color: '#ffb4b4', fontWeight: '700' },
  navRow: { flexDirection: 'row', flexWrap: 'wrap', padding: 12, backgroundColor: '#0e2d3c' },
  tabButton: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#123548', margin: 4 },
  tabButtonActive: { backgroundColor: '#36a2ff' },
  tabText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  scrollContent: { padding: 16, paddingBottom: 100 },
  pageWrap: { paddingBottom: 12 },
  title: { fontSize: 26, color: '#eaf7ff', fontWeight: '700', marginBottom: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  statusBadge: { fontSize: 18, fontWeight: '700', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, overflow: 'hidden' },
  safe: { backgroundColor: '#1d8f5d', color: '#fff' },
  warning: { backgroundColor: '#d78b12', color: '#fff' },
  danger: { backgroundColor: '#d73b3b', color: '#fff' },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 18 },
  summaryCard: { width: '48%', backgroundColor: '#102e3d', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#234f68' },
  summaryLabel: { color: '#9ec0d4', fontSize: 12, marginBottom: 8 },
  summaryValue: { color: '#feffff', fontSize: 24, fontWeight: '700' },
  sectionTitle: { color: '#edf9ff', fontSize: 18, fontWeight: '700', marginVertical: 12 },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  metricCard: { width: '48%', backgroundColor: '#0e2b38', borderRadius: 14, padding: 16, marginBottom: 12, borderTopWidth: 4 },
  metricLabel: { color: '#9ec0d4', fontSize: 13, marginBottom: 8 },
  metricValue: { color: '#fff', fontSize: 26, fontWeight: '700' },
  fieldInfoBox: { backgroundColor: '#0d2d3d', borderRadius: 14, padding: 16, marginTop: 8, borderWidth: 1, borderColor: '#224f69' },
  fieldInfoTitle: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 10 },
  fieldInfoText: { color: '#dff1ff', fontSize: 14, marginBottom: 6 },
  fieldCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0d2d3d', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#224f69', marginBottom: 10 },
  fieldCardSelected: { borderColor: '#36a2ff', backgroundColor: '#10364b' },
  fieldCardTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 6 },
  fieldCardText: { color: '#afccdc', fontSize: 12, marginBottom: 2 },
  fieldCardCode: { color: '#9be7ff', fontSize: 12, fontWeight: '700' },
  userCard: { backgroundColor: '#0e2b38', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#224f69' },
  formCard: { backgroundColor: '#0d2d3d', borderRadius: 14, padding: 16, marginTop: 12, borderWidth: 1, borderColor: '#224f69' },
  mapCard: { backgroundColor: '#0e2b38', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#224f69' },
  loginContainer: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#061922' },
  loginCard: { backgroundColor: '#0d2d3d', borderRadius: 20, padding: 24, borderWidth: 1, borderColor: '#1d5670' },
  loginTitle: { color: '#edf9ff', fontSize: 30, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  loginSubtitle: { color: '#9ec0d4', fontSize: 16, textAlign: 'center', marginBottom: 22 },
  roleRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  roleButton: { flex: 1, backgroundColor: '#123548', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginHorizontal: 4 },
  roleButtonActive: { backgroundColor: '#36a2ff' },
  roleButtonText: { color: '#fff', fontWeight: '700' },
  hostTitle: { color: '#9ec0d4', fontSize: 14, marginBottom: 10, marginTop: 8 },
  hostRow: { flexDirection: 'row', justifyContent: 'space-between' },
  input: { backgroundColor: '#112f3f', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: '#fff', fontSize: 16, borderWidth: 1, borderColor: '#214c66', marginBottom: 14 },
  halfInput: { width: '48%' },
  loginButton: { backgroundColor: '#36a2ff', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  loginButtonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  primaryButton: { backgroundColor: '#36a2ff', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  alertCard: { backgroundColor: '#103548', borderRadius: 12, padding: 14, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: '#facc15' },
  alertTitle: { color: '#fff', fontWeight: '700', fontSize: 16, marginBottom: 8 },
  alertText: { color: '#dfefff', fontSize: 13, marginBottom: 10 },
  alertMetaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  alertMeta: { color: '#9ec0d4', fontSize: 12 },
  actionButton: { position: 'absolute', right: 16, bottom: 18, left: 16, backgroundColor: '#36a2ff', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  actionButtonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});
