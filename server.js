// server_2.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

// 1. 環境変数のバリデーション (必須設定が欠けていると起動しない)
const requiredEnv = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID', 'FIREBASE_SERVICE_ACCOUNT'];
requiredEnv.forEach((env) => {
  if (!process.env[env]) {
    throw new Error(`FATAL ERROR: Environment variable ${env} is missing.`);
  }
});

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());

// Firebase Admin SDKの初期化
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Stripe Webhook (認証不要)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET.trim();
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`[Webhook Error] 署名検証失敗: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // イベント処理
  if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.updated') {
    const sessionOrSub = event.data.object;
    const customerId = sessionOrSub.customer;
    
    if (event.type === 'checkout.session.completed') {
      const uid = sessionOrSub.client_reference_id; 
      await db.collection('users').doc(uid).set({
        stripeCustomerId: customerId,
        subscriptionStatus: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      const usersRef = db.collection('users');
      const snapshot = await usersRef.where('stripeCustomerId', '==', customerId).get();
      snapshot.forEach(async doc => {
        await doc.ref.update({
          subscriptionStatus: sessionOrSub.status,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 認証ミドルウェア
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

// APIエンドポイント群... (以前のコードのまま機能は保持)
app.get('/api/subscription/status', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.uid).get();
    res.json({ status: doc.exists ? (doc.data().subscriptionStatus || 'inactive') : 'inactive' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/subscription/create-checkout', authenticate, async (req, res) => {
  try {
    const domainURL = 'https://kinko-app-final-4se3.onrender.com';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: req.email,
      client_reference_id: req.uid,
      line_items: [{ price: process.env.STRIPE_PRICE_ID.trim(), quantity: 1 }],
      success_url: `${domainURL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainURL}/`,
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ... (他、config/save, load, history等の実装はそのまま)
// 全てのルーティングの最後に配置
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
