const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
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
};

let pool;
async function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}

async function ensureSchema() {
  try {
    const p = await getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS moods (
        id INT AUTO_INCREMENT PRIMARY KEY,
        date DATE NOT NULL UNIQUE,
        mood TINYINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CHECK (mood BETWEEN 1 AND 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (error) {
    console.warn('DB schema init skipped or failed:', error.message);
  }
}

// Health endpoint
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Get moods in date range [from, to]
app.get('/api/moods', async (req, res) => {
  const { from, to } = req.query;
  console.log('Fetching moods from:', from, 'to:', to);
  
  if (!from || !to) {
    return res.status(400).json({ error: 'Query params from and to are required (YYYY-MM-DD)' });
  }
  try {
    const p = await getPool();
    const [rows] = await p.query(
      'SELECT DATE_FORMAT(date, "%Y-%m-%d") as date, mood FROM moods WHERE date BETWEEN ? AND ? ORDER BY date ASC',
      [from, to]
    );
    console.log('DB returned:', rows);
    res.json(rows);
  } catch (error) {
    console.error('DB fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch moods', details: error.message });
  }
});

// Save or update mood for a given date
app.post('/api/moods', async (req, res) => {
  const { date, mood } = req.body || {};
  console.log('Server received:', { date, mood });
  
  if (!date || typeof mood !== 'number') {
    return res.status(400).json({ error: 'Body must include date (YYYY-MM-DD) and mood (1..5)' });
  }
  if (mood < 1 || mood > 5) {
    return res.status(400).json({ error: 'Mood must be between 1 and 5' });
  }
  
  // Check if date is not in the future
  const inputDate = new Date(date);
  const today = new Date();
  today.setHours(23, 59, 59, 999); // End of today
  
  if (inputDate > today) {
    return res.status(400).json({ error: 'Cannot set mood for future dates' });
  }
  
  try {
    const p = await getPool();
    console.log('Saving to DB:', { date, mood });
    await p.query(
      `INSERT INTO moods (date, mood) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE mood = VALUES(mood), updated_at = CURRENT_TIMESTAMP`,
      [date, mood]
    );
    console.log('Successfully saved to DB');
    res.json({ ok: true });
  } catch (error) {
    console.error('DB error:', error);
    res.status(500).json({ error: 'Failed to save mood', details: error.message });
  }
});

// Fallback to index.html for root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  await ensureSchema();
  console.log(`Mood Tracker server running on http://localhost:${PORT}`);
});


