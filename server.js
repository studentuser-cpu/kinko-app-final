const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ════════════════════════════════════════
// 起動時に環境変数チェック
// ════════════════════════════════════════
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  'FIREBASE_SERVICE_ACCOUNT'
];
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`致命的エラー: 環境変数 "${key}" が設定されていません。サーバーを起動できません。`);
    process.exit(1);
  }
}

const app = express();

// ════════════════════════════════════════
// セキュリティ強化: Helmet の導入
// フロントエンドの動作（FirebaseやStripe）を妨げないセーフ設定です
// ════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false,
}));

// ════════════════════════════════════════
// セキュリティ強化: CORS設定
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
// Firebase Admin SDKの初期化
// ════════════════════════════════════════
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ════════════════════════════════════════
// Stripe Webhook (JSONパースの前に配置)
// ════════════════════════════════════════
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET
    ? process.env.STRIPE_WEBHOOK_SECRET.trim()
    : undefined;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook署名検証エラー: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'customer.subscription.updated'
    ) {
      const sessionOrSub = event.data.object;
      const customerId = sessionOrSub.customer;

      if (event.type === 'checkout.session.completed') {
        const uid = sessionOrSub.client_reference_id;
        if (!uid) {
          console.warn('Webhook: checkout.session.completed にclient_reference_idが含まれていません');
        } else {
          await db.collection('users').doc(uid).set({
            stripeCustomerId: customerId,
            subscriptionStatus: 'active',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`✅ サブスクリプション開始: uid=${uid}`);
        }
      } else {
        const snapshot = await db.collection('users')
          .where('stripeCustomerId', '==', customerId)
          .get();

        if (!snapshot.empty) {
          for (const doc of snapshot.docs) {
            await doc.ref.update({
              subscriptionStatus: sessionOrSub.status,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
          console.log(`🔄 サブスクリプション更新: customerId=${customerId}, status=${sessionOrSub.status}`);
        } else {
          console.warn(`Webhook: stripeCustomerId=${customerId} に対応するユーザーが見つかりません`);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const snapshot = await db.collection('users')
        .where('stripeCustomerId', '==', subscription.customer)
        .get();

      if (!snapshot.empty) {
        for (const doc of snapshot.docs) {
          await doc.ref.update({
            subscriptionStatus: 'canceled',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        console.log(`🔴 サブスクリプション解約: customerId=${subscription.customer}`);
      } else {
        console.warn(`Webhook: stripeCustomerId=${subscription.customer} に対応するユーザーが見つかりません`);
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const snapshot = await db.collection('users')
        .where('stripeCustomerId', '==', invoice.customer)
        .get();

      if (!snapshot.empty) {
        for (const doc of snapshot.docs) {
          await doc.ref.update({
            subscriptionStatus: 'past_due',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        console.log(`⚠️ 支払い失敗: customerId=${invoice.customer}`);
      }
    }

  } catch (e) {
    console.error('Webhook処理エラー:', e.message);
  }

  res.json({ received: true });
});

// ════════════════════════════════════════
// 通常のJSONリクエスト処理
// ════════════════════════════════════════
app.use(express.json());

// セキュリティ強化: APIへの過剰リクエスト（DoS・ブルートフォース）制限
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 300, // 最大300リクエストまで
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらく時間をおいてから再度お試しください。' }
});
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));

// ミドルウェア：Firebaseトークン認証
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
// API: サブスクリプション状態を確認
// ════════════════════════════════════════
app.get('/api/subscription/status', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.uid).get();
    if (!doc.exists) return res.json({ status: 'inactive' });
    res.json({ status: doc.data().subscriptionStatus || 'inactive' });
  } catch (e) {
    console.error('エラー:', e);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// ════════════════════════════════════════
// API: Stripe Checkoutセッションを作成
// ════════════════════════════════════════
app.post('/api/subscription/create-checkout', authenticate, async (req, res) => {
  try {
    const domainURL = process.env.APP_URL || 'https://kinko-app-final-4se3.onrender.com';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: req.email,
      client_reference_id: req.uid,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID.trim(),
          quantity: 1,
        },
      ],
      success_url: `${domainURL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainURL}/`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripeエラー:', e);
    res.status(500).json({ error: '決済処理の開始に失敗しました' });
  }
});

// ════════════════════════════════════════
// API: 設定を保存
// ════════════════════════════════════════
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
    console.error('エラー:', e);
    res.status(500).json({ error: '保存に失敗しました' });
  }
});

// ════════════════════════════════════════
// API: 設定を読み込み
// ════════════════════════════════════════
app.get('/api/config/load', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('vaultConfigs').doc(req.uid).get();
    if (!doc.exists) return res.json({ config: null });
    res.json({ config: doc.data().config });
  } catch (e) {
    console.error('エラー:', e);
    res.status(500).json({ error: '読み込みに失敗しました' });
  }
});

// ════════════════════════════════════════
// API: 計算ロジック
// ════════════════════════════════════════
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
    console.error('エラー:', e);
    res.status(500).json({ error: '計算処理中にエラーが発生しました' });
  }
});

// ════════════════════════════════════════
// API: 履歴を保存
// ════════════════════════════════════════
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
    console.error('エラー:', e);
    res.status(500).json({ error: '履歴の保存に失敗しました' });
  }
});

// ════════════════════════════════════════
// API: 履歴を取得
// ════════════════════════════════════════
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
    console.error('エラー:', e);
    res.status(500).json({ error: '履歴の取得に失敗しました' });
  }
});

// ════════════════════════════════════════
// API: 履歴を削除
// ════════════════════════════════════════
app.post('/api/history/delete', authenticate, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'idがありません' });
  try {
    const doc = await db.collection('vaultHistory').doc(id).get();
    if (!doc.exists || doc.data().uid !== req.uid) return res.status(403).json({ error: '権限がありません' });
    await db.collection('vaultHistory').doc(id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error('エラー:', e);
    res.status(500).json({ error: '履歴の削除に失敗しました' });
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
  console.log(`サーバー起動完了: ポート ${PORT}`);
});
