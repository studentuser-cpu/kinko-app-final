const express = require('express');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Firebase Admin SDKの初期化
// 環境変数 FIREBASE_SERVICE_ACCOUNT にサービスアカウントJSONを文字列で設定してください
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ─── ミドルウェア：Firebaseトークンを検証してユーザーIDを取得 ───
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証トークンがありません' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: '認証失敗: ' + e.message });
  }
}

// ─── API: 設定を保存 ───
app.post('/api/config/save', authenticate, async (req, res) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: 'configがありません' });
  try {
    await db.collection('vaultConfigs').doc(req.uid).set({
      config,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '保存失敗: ' + e.message });
  }
});

// ─── API: 設定を読み込み ───
app.get('/api/config/load', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('vaultConfigs').doc(req.uid).get();
    if (!doc.exists) return res.json({ config: null });
    res.json({ config: doc.data().config });
  } catch (e) {
    res.status(500).json({ error: '読み込み失敗: ' + e.message });
  }
});

// ─── API: 計算ロジック（既存のまま） ───
app.post('/api/calculate', (req, res) => {
  const { inputs, config } = req.body;
  const prices = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1];

  let currentTotal = 0, needMoney = 0, availableMoney = 0;
  let results = {};

  prices.forEach(price => {
    const s = config.denoms[price];
    const barVal = Number(inputs[price]?.b || 0);
    const coinVal = Number(inputs[price]?.c || 0);

    let rowAmount = (s.bMode !== "none" || s.cMode !== "none")
      ? ((barVal * s.perBar) + coinVal) * price : 0;
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

  const diffVal = currentTotal - config.vaultTotal;
  res.json({ currentTotal, diffVal, needMoney, availableMoney, results });
});

// ─── API: 履歴を保存 ───
app.post('/api/history/save', authenticate, async (req, res) => {
  const { snapshot } = req.body;
  if (!snapshot) return res.status(400).json({ error: 'snapshotがありません' });
  try {
    await db.collection('vaultHistory').add({
      uid: req.uid,
      ...snapshot,
      savedAt: snapshot.savedAt || new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '保存失敗: ' + e.message });
  }
});

// ─── API: 履歴を取得（新しい順・最大50件） ───
app.get('/api/history/load', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('vaultHistory')
      .where('uid', '==', req.uid)
      .orderBy('savedAt', 'desc')
      .limit(50)
      .get();
    const history = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ history });
  } catch (e) {
    res.status(500).json({ error: '読み込み失敗: ' + e.message });
  }
});

// ─── API: 履歴を削除 ───
app.post('/api/history/delete', authenticate, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'idがありません' });
  try {
    const doc = await db.collection('vaultHistory').doc(id).get();
    if (!doc.exists || doc.data().uid !== req.uid) return res.status(403).json({ error: '権限がありません' });
    await db.collection('vaultHistory').doc(id).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '削除失敗: ' + e.message });
  }
});

// ─── SPAフォールバック ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
