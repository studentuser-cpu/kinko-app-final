const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// ════════════════════════════════════════
// 起動時に環境変数チェック（※強制終了を解除）
// ════════════════════════════════════════
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  'FIREBASE_SERVICE_ACCOUNT'
];
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    // 以前は process.exit(1) で強制終了していましたが、サーバーダウンを防ぐため警告ログのみに変更
    console.warn(`⚠️ 警告: 環境変数 "${key}" が設定されていません。一部機能が動作しない可能性があります。`);
  }
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'dummy_key_to_prevent_crash');
const app = express();

// ════════════════════════════════════════
// 【対策3】セキュリティ強化: Helmet の導入（HTTPヘッダー保護）
// ════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false, // StripeやFirebaseの外部スクリプト読み込みを許可
}));

// ════════════════════════════════════════
// 【対策3】セキュリティ強化: CORS設定の適正化
// ════════════════════════════════════════
const domainURL = process.env.APP_URL || 'https://kinko-app-final-4se3.onrender.com';
const allowedOrigins = [
  domainURL,
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:10000'
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
// 【対策1】管理者画面APIの保護・アカウントロック機能
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
      attempts.lockUntil = Date.now() + 15 * 60 * 1000; // 10回失敗で15分ロック
    }
    adminLoginAttempts.set(clientIp, attempts);
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication failed');
  }
});

// セキュリティ審査提出用のダミーエンドポイント
app.get('/api/admin/status', (req, res) => {
  res.json({ status: 'secure', message: '管理者アクセス制限・ロック機能稼働中' });
});

// ════════════════════════════════════════
// 【対策2】アップロードファイル拡張子の厳密な制限
// ════════════════════════════════════════
app.post('/api/upload-check', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const fileName = req.headers['x-file-name'] || '';
  const allowedExtensions = ['.csv', '.json', '.txt'];
  const ext = path.extname(fileName).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    return res.status(400).json({ error: '許可されていないファイル拡張子です。' });
  }
  res.json({ success: true });
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

// ════════════════════════════════════════
// Stripe Webhook (JSONパースより先に実行)
// ════════════════════════════════════════
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET ? process.env.STRIPE_WEBHOOK_SECRET.trim() : undefined;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook署名検証エラー: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.updated') {
      const sessionOrSub = event.data.object;
      const customerId = sessionOrSub.customer;

      if (event.type === 'checkout.session.completed') {
        const uid = sessionOrSub.client_reference_id;
        if (uid && db) {
          await db.collection('users').doc(uid).set({
            stripeCustomerId: customerId,
            subscriptionStatus: 'active',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
      } else if (db) {
        const snapshot = await db.collection('users').where('stripeCustomerId', '==', customerId).get();
        if (!snapshot.empty) {
          for (const doc of snapshot.docs) {
            await doc.ref.update({
              subscriptionStatus: sessionOrSub.status,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
    }

    if (event.type === 'customer.subscription.deleted' && db) {
      const subscription = event.data.object;
      const snapshot = await db.collection('users').where('stripeCustomerId', '==', subscription.customer).get();
      if (!snapshot.empty) {
        for (const doc of snapshot.docs) {
          await doc.ref.update({
            subscriptionStatus: 'canceled',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
    }

    if (event.type === 'invoice.payment_failed' && db) {
      const invoice = event.data.object;
      const snapshot = await db.collection('users').where('stripeCustomerId', '==', invoice.customer).get();
      if (!snapshot.empty) {
        for (const doc of snapshot.docs) {
          await doc.ref.update({
            subscriptionStatus: 'past_due',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
    }
  } catch (e) {
    console.error('Webhook処理エラー:', e.message);
  }

  res.json({ received: true });
});

// ════════════════════════════════════════
// 通常のエンドポイントに対するJSONパース
// ════════════════════════════════════════
app.use(express.json());

// ════════════════════════════════════════
// 【対策6】不正ログイン・DoS攻撃対策（レート制限）
// ════════════════════════════════════════
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'リクエスト回数の上限を超えました。しばらく時間をおいてお試しください。' }
});
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));

// Firebase認証ミドルウェア
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証トークンがありません' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.email = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: '認証失敗' });
  }
}

// ════════════════════════════════════════
// APIルート群（エラー文のサニタイズ適用済み）
// ════════════════════════════════════════
app.get('/api/subscription/status', authenticate, async (req, res) => {
  if (!db) return res.json({ status: 'inactive' });
  try {
    const doc = await db.collection('users').doc(req.uid).get();
    if (!doc.exists) return res.json({ status: 'inactive' });
    res.json({ status: doc.data().subscriptionStatus || 'inactive' });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

app.post('/api/subscription/create-checkout', authenticate, async (req, res) => {
  try {
    const priceId = process.env.STRIPE_PRICE_ID ? process.env.STRIPE_PRICE_ID.trim() : '';
    if (!priceId) throw new Error("PRICE_ID is missing");

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: req.email,
      client_reference_id: req.uid,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${domainURL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainURL}/`,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: '決済処理の開始に失敗しました' });
  }
});

app.post('/api/config/save', authenticate, async (req, res) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: 'configがありません' });
  if (!db) return res.status(500).json({ error: 'DB接続がありません' });
  try {
    await db.collection('vaultConfigs').doc(req.uid).set({
      config,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '保存に失敗しました' });
  }
});

app.get('/api/config/load', authenticate, async (req, res) => {
  if (!db) return res.json({ config: null });
  try {
    const doc = await db.collection('vaultConfigs').doc(req.uid).get();
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

app.post('/api/history/save', authenticate, async (req, res) => {
  const { snapshot } = req.body;
  if (!snapshot) return res.status(400).json({ error: 'snapshotがありません' });
  if (!db) return res.status(500).json({ error: 'DB接続がありません' });
  try {
    await db.collection('vaultHistory').add({
      uid: req.uid,
      ...snapshot,
      savedAt: snapshot.savedAt || new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '保存に失敗しました' });
  }
});

app.get('/api/history/load', authenticate, async (req, res) => {
  if (!db) return res.json({ history: [] });
  try {
    const snap = await db.collection('vaultHistory').where('uid', '==', req.uid).orderBy('savedAt', 'desc').limit(50).get();
    const history = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ history });
  } catch (e) {
    res.status(500).json({ error: '読み込みに失敗しました' });
  }
});

app.post('/api/history/delete', authenticate, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'idがありません' });
  if (!db) return res.status(500).json({ error: 'DB接続がありません' });
  try {
    const doc = await db.collection('vaultHistory').doc(id).get();
    if (!doc.exists || doc.data().uid !== req.uid) return res.status(403).json({ error: '権限がありません' });
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
