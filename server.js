const express = require('express');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ════════════════════════════════════════
// ★ 修正②: 起動時に環境変数チェック
//    必須の環境変数が未設定の場合、起動直後に明確なエラーで停止させます
//    これにより「なぜか動かない」という状況を防ぎます
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
app.use(cors());

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
//    Stripeの署名検証はraw bodyが必要なため、
//    express.json()が先に動くとbodyが変換されてしまい署名検証に失敗します
// ════════════════════════════════════════
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  // ★ .trim() でWebhookシークレットの前後の空白・改行を除去
  //    Renderなどの環境では環境変数の末尾に改行が入ることがあるため
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
    // ────────────────────────────────────
    // Case 1: Checkoutセッション完了 または サブスクリプション更新
    // ────────────────────────────────────
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'customer.subscription.updated'
    ) {
      const sessionOrSub = event.data.object;
      const customerId = sessionOrSub.customer;

      if (event.type === 'checkout.session.completed') {
        // client_reference_id にuidを設定しているため、そこから取得
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
        // customer.subscription.updated の場合
        // stripeCustomerIdでユーザーを検索して更新する
        const snapshot = await db.collection('users')
          .where('stripeCustomerId', '==', customerId)
          .get();

        if (!snapshot.empty) {
          // ★ 修正③: async forEachのバグを修正
          //    forEach内でawaitしても待機されないため、for...ofに変更
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

    // ────────────────────────────────────
    // Case 2: サブスクリプション削除（解約確定）
    // ────────────────────────────────────
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const snapshot = await db.collection('users')
        .where('stripeCustomerId', '==', subscription.customer)
        .get();

      if (!snapshot.empty) {
        // ★ 修正③: こちらも async forEachのバグを修正 → for...ofに変更
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

    // ────────────────────────────────────
    // Case 3: 支払い失敗
    // ────────────────────────────────────
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
    // Webhook処理中のエラーは200を返してStripeの無限リトライを防ぐ
    // ただしエラーはログに残す
    console.error('Webhook処理エラー:', e.message);
  }

  // ★ 重要: Stripeに「受け取った」と確認を返す
  res.json({ received: true });
});

// ════════════════════════════════════════
// 通常のJSONリクエスト処理（Webhookの後に配置）
// ════════════════════════════════════════
app.use(express.json());
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
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: Stripe Checkoutセッションを作成
// ════════════════════════════════════════
app.post('/api/subscription/create-checkout', authenticate, async (req, res) => {
  try {
    // ★ 修正⑤: domainURLを環境変数から取得
    //    ハードコードをやめ、APP_URL環境変数を参照します
    //    フォールバックとして以前のURLを残してありますが、
    //    Renderの環境変数に APP_URL を追加することを強く推奨します
    const domainURL = process.env.APP_URL || 'https://kinko-app-final-4se3.onrender.com';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: req.email,
      // ★ client_reference_id にFirebaseのuidを渡す
      //    Webhookでこの値を使ってユーザーを特定します
      client_reference_id: req.uid,
      line_items: [
        {
          // ★ .trim() でPRICE_IDの前後の空白・改行を除去
          price: process.env.STRIPE_PRICE_ID.trim(),
          quantity: 1,
        },
      ],
      // 支払い完了後のリダイレクト先
      success_url: `${domainURL}/?session_id={CHECKOUT_SESSION_ID}`,
      // 支払いキャンセル後のリダイレクト先
      cancel_url: `${domainURL}/`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe Checkoutセッション作成エラー:', e);
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: '保存失敗: ' + e.message });
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
    res.status(500).json({ error: '読み込み失敗: ' + e.message });
  }
});

// ════════════════════════════════════════
// API: 計算ロジック
// ════════════════════════════════════════
app.post('/api/calculate', (req, res) => {
  const { inputs, config } = req.body;
  const prices = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1];
  let currentTotal = 0, needMoney = 0, availableMoney = 0;
  let results = {};

  prices.forEach(price => {
    const s = config.denoms[price];
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

  const diffVal = currentTotal - config.vaultTotal;
  res.json({ currentTotal, diffVal, needMoney, availableMoney, results });
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
    res.status(500).json({ error: '保存失敗: ' + e.message });
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
    res.status(500).json({ error: '読み込み失敗: ' + e.message });
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
    res.status(500).json({ error: '削除失敗: ' + e.message });
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
