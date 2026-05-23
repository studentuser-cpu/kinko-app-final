const express = require('express');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());

// Firebase Admin SDKの初期化
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Stripe Webhook (必ず express.json() の前に配置)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

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
      if (!snapshot.empty) {
        snapshot.forEach(async doc => {
          await doc.ref.update({
            subscriptionStatus: sessionOrSub.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const snapshot = await db.collection('users').where('stripeCustomerId', '==', subscription.customer).get();
    if (!snapshot.empty) {
      snapshot.forEach(async doc => await doc.ref.update({ subscriptionStatus: 'canceled' }));
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/subscription/status', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.uid).get();
    if (!doc.exists) return res.json({ status: 'inactive' });
    res.json({ status: doc.data().subscriptionStatus || 'inactive' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/subscription/create-checkout', authenticate, async (req, res) => {
  try {
    const domainURL = process.env.CLIENT_URL || 'http://localhost:10000';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: req.email,
      client_reference_id: req.uid,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${domainURL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainURL}/`,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.get('/api/config/load', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('vaultConfigs').doc(req.uid).get();
    if (!doc.exists) return res.json({ config: null });
    res.json({ config: doc.data().config });
  } catch (e) {
    res.status(500).json({ error: '読み込み失敗: ' + e.message });
  }
});

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

app.get('/api/history/load', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('vaultHistory').where('uid', '==', req.uid).orderBy('savedAt', 'desc').limit(50).get();
    const history = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ history });
  } catch (e) {
    res.status(500).json({ error: '読み込み失敗: ' + e.message });
  }
});

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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
