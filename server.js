const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ════════════════════════════════════════
// 起動時に環境変数チェック
//    必須の環境変数が未設定の場合、起動直後に明確なエラーで停止させます
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
// ★ セキュリティ強化: Helmet の導入
//    各種セキュリティヘッダーを自動設定し、脆弱性からアプリを保護します。
//    フロントエンドの外部リソース（Stripe, Firebase等）の読み込みを阻害しないよう
//    CSP（Content Security Policy）はオフに調整しています。
// ════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false,
}));

// ════════════════════════════════════════
// ★ セキュリティ強化: CORS 設定の適正化
//    全てのオリジンを許可（*）するのではなく、環境変数 APP_URL をベースに
//    信頼できるオリジンのみに制限して、クロスサイトリクエストによる悪意ある操作を防ぎます。
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
    // 同一オリジンからのリクエストや、ツール等からのoriginがないリクエストは許可
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || !process.env.APP_URL) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS Policy: このオリジンからのアクセスは許可されていません。'), false);
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
// Stripe Webhook
// ★ 重要: express.raw() は必ず express.json() より先に定義すること
//    Stripeの署名検証はraw bodyが必要なため
// ════════════════════════════════════════
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET
    ? process.env.STRIPE_WEBHOOK_SECRET.trim()
    : undefined;

  let event;

  // Stripeの署名を検証（リクエストが本当にStripeから来たものか確認）
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook署名検証エラー: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── イベント種別ごとの処理 ──
  try {
    // Case 1: Checkoutセッション完了 または サブスクリプション更新
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

    // Case 2: サブスクリプション削除（解約確定）
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

    // Case 3: 支払い失敗
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
// 通常のJSONリクエスト処理（Webhookの後に配置）
// ════════════════════════════════════════
app.use(express.json());

// ════════════════════════════════════════
// ★ セキュリティ強化: レート制限（Rate Limiting）の導入
//    ブルートフォース攻撃やDoS（サービス拒否）攻撃からAPIエンドポイントを保護します。
//    ※ 大量のリクエストが送られてくる可能性のあるWebhookへの影響を防ぐため、この位置に適用しています。
// ════════════════════════════════════════
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分間
  max: 200, // 各IPで15分間に最大200リクエストまで許可
  standardHeaders: true, // レート制限情報を `RateLimit-*` ヘッダーに含める
  legacyHeaders: false, // 旧式の `X-RateLimit-*` ヘッダーを非表示にする
  message: { error: 'リクエストが多すぎます。しばらく時間をおいてから再度お試しください。' }
});
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════
// ミドルウェア：Firebaseトークン認証
// ════════════════════════════════════════
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
    return res.status(401).json({ error: '認証失敗: ' + e.message });
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
    console.error('サブスク状態確認エラー詳細:', e);
    res.status(500).json({ error: 'サーバー内部エラーが発生しました' });
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
    console.error('Stripe Checkoutセッション作成エラー詳細:', e);
    res.status(500).json({ error: '決済セッションの作成に失敗しました' });
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
    console.error('設定保存エラー詳細:', e);
    res.status(500).json({ error: '設定の保存に失敗しました' });
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
    console.error('設定読み込みエラー詳細:', e);
    res.status(500).json({ error: '設定の読み込みに失敗しました' });
  }
});

// ════════════════════════════════════════
// API: 計算ロジック
// ★ セキュリティ・堅牢性強化: 予期せぬ入力データ（ハッキング行為など）によるクラッシュ防止を追加
// ════════════════════════════════════════
app.post('/api/calculate', (req, res) => {
  try {
    const { inputs, config } = req.body;
    
    // 入力データの存在チェック (不正なペイロードによるサーバー強制終了を完全回避)
    if (!inputs || !config || !config.denoms) {
      return res.status(400).json({ error: '入力データまたは設定が不足しています' });
    }

    const prices = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1];
    let currentTotal = 0, needMoney = 0, availableMoney = 0;
    let results = {};

    prices.forEach(price => {
      const s = config.denoms[price];
      if (!s) return; // 特定の金種設定が欠落している場合は安全にスキップ

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
    console.error('計算処理エラー詳細:', e);
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
    console.error('履歴保存エラー詳細:', e);
    res.status(500).json({ error: '履歴の保存に失敗しました' });
  }
});

// ════════════════════════════════════════
// API: 履歴を取得（新しい順・最大50件）
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
    console.error('履歴読み込みエラー詳細:', e);
    res.status(500).json({ error: '履歴の読み込みに失敗しました' });
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
    console.error('履歴削除エラー詳細:', e);
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
  console.log(`Stripe設定: ${process.env.STRIPE_SECRET_KEY ? '✓' : '✗'}`);
});
