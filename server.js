const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// ════════════════════════════════════════
// 起動時に環境変数チェック
// ════════════════════════════════════════
const requiredEnvVars = [
  'FIREBASE_SERVICE_ACCOUNT'
];
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.warn(`⚠️ 警告: 環境変数 "${key}" が設定されていません。データベース機能が動作しない可能性があります。`);
  }
}

const app = express();

// ════════════════════════════════════════
// セキュリティ強化: Helmet の導入
// ════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false,
}));

// ════════════════════════════════════════
// CORS設定の適正化
// ════════════════════════════════════════
const domainURL = process.env.APP_URL || 'https://kinko-app-final-4se3.onrender.com';
const allowedOrigins = [
  domainURL,
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:10000',
  'https://r-w-kinko.github.io' // ← もしGitHub Pagesをお使いなら自分のURLを追加してください
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || !process.env.APP_URL) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS Policy Error'), false);
    }
  }
}));

// ════════════════════════════════════════
// 管理者画面APIの保護・アカウントロック機能
// ════════════════════════════════════════
const adminLoginAttempts = new Map();
const ALLOWED_ADMIN_IPS = process.env.ALLOWED_ADMIN_IPS ? process.env.ALLOWED_ADMIN_IPS.split(',') : [];

app.use('/api/admin', (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const attempts = adminLoginAttempts.get(clientIp) || { count: 0, lockUntil: 0 };
  
  if (attempts.lockUntil > Date.now()) {
    return res.status(423).json({ error: 'ログイン失敗上限に達したため、アクセスがロックされています。' });
  }
  if (ALLOWED_ADMIN_IPS.length > 0 && !ALLOWED_ADMIN_IPS.includes(clientIp)) {
    return res.status(403).json({ error: 'アクセスが許可されていないIPアドレスです。' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const user = auth[0];
  const pass = auth[1];

  const secureAdminUser = process.env.ADMIN_USER || 'admin';
  const secureAdminPass = process.env.ADMIN_PASS || 'SecurePassword123!';

  if (user === secureAdminUser && pass === secureAdminPass) {
    adminLoginAttempts.delete(clientIp);
    next();
  } else {
    attempts.count += 1;
    if (attempts.count >= 10) {
      attempts.lockUntil = Date.now() + 15 * 60 * 1000;
    }
    adminLoginAttempts.set(clientIp, attempts);
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication failed');
  }
});

app.get('/api/admin/status', (req, res) => {
  res.json({ status: 'secure', message: '管理者アクセス制限・ロック機能稼働中' });
});

// ════════════════════════════════════════
// Firebase Admin SDKの初期化
// ════════════════════════════════════════
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (Object.keys(serviceAccount).length > 0) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
  } else {
    console.warn("⚠️ Firebaseサービスアカウントが未設定のため、DB接続をスキップします。");
  }
} catch (e) {
  console.warn("⚠️ Firebaseの初期化に失敗しました。環境変数を確認してください。");
}

app.use(express.json());

// ════════════════════════════════════════
// 不正ログイン・DoS攻撃対策（レート制限）
// ════════════════════════════════════════
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'リクエスト回数の上限を超えました。しばらく時間をおいてお試しください。' }
});
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));

// ★ ログイン機能を外したため、すべてのユーザーで共有する固定のデータ領域を使用します
const DEFAULT_UID = 'shared_vault';

// ════════════════════════════════════════
// APIルート群
// ════════════════════════════════════════
app.post('/api/config/save', async (req, res) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: 'configがありません' });
  if (!db) return res.status(500).json({ error: 'DB接続がありません' });
  try {
    await db.collection('vaultConfigs').doc(DEFAULT_UID).set({
      config,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '保存に失敗しました' });
  }
});

app.get('/api/config/load', async (req, res) => {
  if (!db) return res.json({ config: null });
  try {
    const doc = await db.collection('vaultConfigs').doc(DEFAULT_UID).get();
    if (!doc.exists) return res.json({ config: null });
    res.json({ config: doc.data().config });
  } catch (e) {
    res.status(500).json({ error: '読み込みに失敗しました' });
  }
});

app.post('/api/calculate', (req, res) => {
  try {
    const { inputs, config } = req.body;
    if (!inputs || !config || !config.denoms) {
      return res.status(400).json({ error: '必要なデータが不足しています' });
    }
    const prices = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1];
    let currentTotal = 0, needMoney = 0, availableMoney = 0;
    let results = {};

    prices.forEach(price => {
      const s = config.denoms[price];
      if (!s) return;
      const barVal = Number(inputs[price]?.b || 0);
      const coinVal = Number(inputs[price]?.c || 0);
      let rowAmount = (s.bMode !== "none" || s.cMode !== "none") ? ((barVal * s.perBar) + coinVal) * price : 0;
      currentTotal += rowAmount;
      let bText = "-", bClass = "";
      if (s.bMode !== "hidden" && s.bMode !== "none") {
        const dBar = barVal - s.tBar;
        bText = dBar > 0 ? "+" + dBar : (dBar < 0 ? dBar : "OK");
        bClass = dBar > 0 ? "txt-plus" : (dBar < 0 ? `txt-minus ${s.bMode}` : "txt-ok bg-ok");
        if (dBar > 0 && s.isAvailB) availableMoney += dBar * s.perBar * price;
        if (dBar < 0 && s.bMode === "bg-red") needMoney += Math.abs(dBar) * s.perBar * price;
      }
      let cText = "-", cClass = "";
      if (s.cMode !== "hidden" && s.cMode !== "none") {
        const dCoin = coinVal - s.tCoin;
        cText = dCoin > 0 ? "+" + dCoin : (dCoin < 0 ? dCoin : "OK");
        cClass = dCoin > 0 ? "txt-plus" : (dCoin < 0 ? `txt-minus ${s.cMode}` : "txt-ok bg-ok");
        if (dCoin > 0 && s.isAvailC) availableMoney += dCoin * price;
        if (dCoin < 0 && s.cMode === "bg-red") needMoney += Math.abs(dCoin) * price;
      }
      results[price] = { rowAmount, bText, bClass, cText, cClass };
    });
    const diffVal = currentTotal - (config.vaultTotal || 0);
    res.json({ currentTotal, diffVal, needMoney, availableMoney, results });
  } catch (e) {
    res.status(500).json({ error: '計算処理中にエラーが発生しました' });
  }
});

app.post('/api/history/save', async (req, res) => {
  const { snapshot } = req.body;
  if (!snapshot) return res.status(400).json({ error: 'snapshotがありません' });
  if (!db) return res.status(500).json({ error: 'DB接続がありません' });
  try {
    await db.collection('vaultHistory').add({
      uid: DEFAULT_UID,
      ...snapshot,
      savedAt: snapshot.savedAt || new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '保存に失敗しました' });
  }
});

app.get('/api/history/load', async (req, res) => {
  if (!db) return res.json({ history: [] });
  try {
    const snap = await db.collection('vaultHistory').where('uid', '==', DEFAULT_UID).orderBy('savedAt', 'desc').limit(50).get();
    const history = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ history });
  } catch (e) {
    res.status(500).json({ error: '読み込みに失敗しました' });
  }
});

app.post('/api/history/delete', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'idがありません' });
  if (!db) return res.status(500).json({ error: 'DB接続がありません' });
  try {
    const doc = await db.collection('vaultHistory').doc(id).get();
    if (!doc.exists || doc.data().uid !== DEFAULT_UID) return res.status(403).json({ error: '権限がありません' });
    await db.collection('vaultHistory').doc(id).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '削除に失敗しました' });
  }
});

// ════════════════════════════════════════
// SPAフォールバック
// ════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════
// サーバー起動
// ════════════════════════════════════════
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 サーバー起動完了: ポート ${PORT}`);
});
