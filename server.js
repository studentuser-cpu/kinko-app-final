const express = require('express');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// PostgreSQL 接続
// Render の環境変数 DATABASE_URL が自動でセットされます
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============================================================
// DB初期化（テーブルがなければ作成）
// ============================================================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_records (
      id          SERIAL PRIMARY KEY,
      record_date DATE    NOT NULL UNIQUE,
      inputs      JSONB   NOT NULL DEFAULT '{}',
      config      JSONB,
      saved_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
  console.log('DB initialized');
}

// ============================================================
// API: 日付ごとに保存（上書きOK）
// POST /api/save
// body: { date: "2026-05-22", inputs: {...}, config: {...} }
// ============================================================
app.post('/api/save', async (req, res) => {
  const { date, inputs, config } = req.body;
  if (!date || !inputs) return res.status(400).json({ error: 'date と inputs は必須です' });

  try {
    await pool.query(
      `INSERT INTO vault_records (record_date, inputs, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (record_date)
       DO UPDATE SET inputs = $2, config = $3, saved_at = NOW()`,
      [date, JSON.stringify(inputs), JSON.stringify(config)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: 特定日付のデータを取得
// GET /api/load/:date  例) /api/load/2026-05-22
// ============================================================
app.get('/api/load/:date', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM vault_records WHERE record_date = $1',
      [req.params.date]
    );
    res.json(result.rows[0] || null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: 直近30件の履歴一覧
// GET /api/history
// ============================================================
app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT record_date, saved_at
       FROM vault_records
       ORDER BY record_date DESC
       LIMIT 30`
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: 特定日付のレコードを削除
// DELETE /api/delete/:date
// ============================================================
app.delete('/api/delete/:date', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM vault_records WHERE record_date = $1',
      [req.params.date]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 起動
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Server running on port ${PORT}`);
});
