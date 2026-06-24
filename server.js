const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-mood-tracker-change-in-production';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'mood_tracker',
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00',
};

let pool;
function getPool() {
  if (!pool) pool = mysql.createPool(dbConfig);
  return pool;
}

async function ensureSchema() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      totp_secret VARCHAR(64) NULL,
      totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS moods (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      date DATE NOT NULL,
      mood TINYINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CHECK (mood BETWEEN 1 AND 5),
      UNIQUE KEY uq_user_date (user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

// ── Auth helpers ─────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('session');
    return res.status(401).json({ error: 'Session expired' });
  }
}

function setSession(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body || {};

  if (!username || !email || !password)
    return res.status(400).json({ error: 'Имя пользователя, email и пароль обязательны' });
  if (username.length < 2 || username.length > 50)
    return res.status(400).json({ error: 'Имя должно быть от 2 до 50 символов' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Некорректный email' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Пароль должен быть не менее 8 символов' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const p = getPool();
    const [result] = await p.query(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username.trim(), email.toLowerCase().trim(), hash]
    );
    const user = { id: result.insertId, username: username.trim(), email: email.toLowerCase().trim(), totpEnabled: false };
    setSession(res, { userId: user.id, username: user.username, email: user.email });
    res.json({ ok: true, user });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const field = err.sqlMessage?.includes('email') ? 'email' : 'имя пользователя';
      return res.status(409).json({ error: `Этот ${field} уже занят` });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email и пароль обязательны' });

  try {
    const p = getPool();
    const [rows] = await p.query(
      'SELECT id, username, email, password_hash, totp_secret, totp_enabled FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Неверный email или пароль' });
    const u = rows[0];
    const valid = await bcrypt.compare(password, u.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    if (u.totp_enabled) {
      const tempToken = jwt.sign({ userId: u.id, pending2FA: true }, JWT_SECRET, { expiresIn: '5m' });
      return res.json({ requires2FA: true, tempToken });
    }

    setSession(res, { userId: u.id, username: u.username, email: u.email });
    res.json({ ok: true, user: { id: u.id, username: u.username, email: u.email, totpEnabled: false } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

app.post('/api/auth/totp/verify', async (req, res) => {
  const { tempToken, token } = req.body || {};
  if (!tempToken || !token) return res.status(400).json({ error: 'tempToken и token обязательны' });

  try {
    let payload;
    try { payload = jwt.verify(tempToken, JWT_SECRET); } catch {
      return res.status(401).json({ error: 'Токен истёк или недействителен' });
    }
    if (!payload.pending2FA) return res.status(401).json({ error: 'Неверный тип токена' });

    const p = getPool();
    const [rows] = await p.query(
      'SELECT id, username, email, totp_secret FROM users WHERE id = ?',
      [payload.userId]
    );
    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });
    const u = rows[0];

    if (!authenticator.verify({ token, secret: u.totp_secret }))
      return res.status(401).json({ error: 'Неверный код' });

    setSession(res, { userId: u.id, username: u.username, email: u.email });
    res.json({ ok: true, user: { id: u.id, username: u.username, email: u.email, totpEnabled: true } });
  } catch (err) {
    console.error('TOTP verify error:', err);
    res.status(500).json({ error: 'Ошибка проверки' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const p = getPool();
    const [rows] = await p.query(
      'SELECT id, username, email, totp_enabled FROM users WHERE id = ?',
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    const u = rows[0];
    res.json({ id: u.id, username: u.username, email: u.email, totpEnabled: Boolean(u.totp_enabled) });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Ошибка загрузки профиля' });
  }
});

app.get('/api/auth/totp/setup', requireAuth, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const p = getPool();
    await p.query('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, req.user.userId]);
    const uri = authenticator.keyuri(req.user.email, 'MoodTrack', secret);
    const qrCode = await QRCode.toDataURL(uri);
    res.json({ qrCode, secret });
  } catch (err) {
    console.error('TOTP setup error:', err);
    res.status(500).json({ error: 'Ошибка настройки 2FA' });
  }
});

app.post('/api/auth/totp/enable', requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Код обязателен' });

  try {
    const p = getPool();
    const [rows] = await p.query('SELECT totp_secret FROM users WHERE id = ?', [req.user.userId]);
    if (!rows.length || !rows[0].totp_secret)
      return res.status(400).json({ error: 'Сначала вызовите /api/auth/totp/setup' });
    if (!authenticator.verify({ token, secret: rows[0].totp_secret }))
      return res.status(400).json({ error: 'Неверный код. Попробуйте ещё раз.' });
    await p.query('UPDATE users SET totp_enabled = TRUE WHERE id = ?', [req.user.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('TOTP enable error:', err);
    res.status(500).json({ error: 'Ошибка включения 2FA' });
  }
});

app.post('/api/auth/totp/disable', requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Введите код для отключения 2FA' });

  try {
    const p = getPool();
    const [rows] = await p.query('SELECT totp_secret FROM users WHERE id = ?', [req.user.userId]);
    if (!rows.length || !rows[0].totp_secret)
      return res.status(400).json({ error: '2FA не включена' });
    if (!authenticator.verify({ token, secret: rows[0].totp_secret }))
      return res.status(400).json({ error: 'Неверный код' });
    await p.query('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = ?', [req.user.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('TOTP disable error:', err);
    res.status(500).json({ error: 'Ошибка отключения 2FA' });
  }
});

// ── Mood endpoints ────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/moods', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Параметры from и to обязательны (YYYY-MM-DD)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return res.status(400).json({ error: 'Даты должны быть в формате YYYY-MM-DD' });

  try {
    const p = getPool();
    const [rows] = await p.query(
      'SELECT DATE_FORMAT(date, "%Y-%m-%d") AS date, mood FROM moods WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date ASC',
      [req.user.userId, from, to]
    );
    res.json(rows);
  } catch (err) {
    console.error('Fetch moods error:', err);
    res.status(500).json({ error: 'Ошибка загрузки данных' });
  }
});

app.post('/api/moods', requireAuth, async (req, res) => {
  const { date, mood } = req.body || {};
  if (!date || typeof mood !== 'number')
    return res.status(400).json({ error: 'date (YYYY-MM-DD) и mood (1-5) обязательны' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
  if (!Number.isInteger(mood) || mood < 1 || mood > 5)
    return res.status(400).json({ error: 'mood должно быть целым числом от 1 до 5' });

  // Compare as UTC date strings to avoid timezone issues
  const todayUTC = new Date().toISOString().slice(0, 10);
  if (date > todayUTC)
    return res.status(400).json({ error: 'Нельзя ставить настроение на будущие даты' });

  try {
    const p = getPool();
    await p.query(
      `INSERT INTO moods (user_id, date, mood) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE mood = VALUES(mood), updated_at = CURRENT_TIMESTAMP`,
      [req.user.userId, date, mood]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Save mood error:', err);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  try { await ensureSchema(); } catch (e) { console.warn('Schema init failed:', e.message); }
  console.log(`MoodTrack running on http://localhost:${PORT}`);
});

async function shutdown() {
  server.close();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
