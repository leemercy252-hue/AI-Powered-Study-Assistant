const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const paypal = require('@paypal/checkout-server-sdk');
const crypto = require('crypto');
const db = require('./db');
const jwt = require('jsonwebtoken');

// Configure PayPal environment using env vars
// PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=(sandbox|live)
const clientId = process.env.PAYPAL_CLIENT_ID || '';
const clientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
const envName = (process.env.PAYPAL_ENV || 'sandbox');

let environment = envName === 'live' ? new paypal.core.LiveEnvironment(clientId, clientSecret) : new paypal.core.SandboxEnvironment(clientId, clientSecret);
let client = new paypal.core.PayPalHttpClient(environment);

const FLW_SECRET = process.env.FLW_SECRET_KEY || ''; // Flutterwave secret key

const app = express();
// Capture raw body for webhook signature verification
app.use(bodyParser.json({ verify: function(req, res, buf){ req.rawBody = buf; } }));

app.get('/', (req, res) => res.send('Payment server running'));

// Merchant config endpoint - exposes non-secret client IDs to frontend
app.get('/merchant-config', (req, res) => {
  const cfg = {
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    paypalEnv: process.env.PAYPAL_ENV || 'sandbox',
    flutterwavePublic: process.env.FLW_PUBLIC_KEY || ''
  };
  res.json(cfg);
});

// --- PayPal endpoints ---
// Create order
app.post('/create-order', async (req, res) => {
  const { amount, currency } = req.body;
  if (!amount) return res.status(400).json({ error: 'Missing amount' });
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer('return=representation');
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: (currency||'EUR'), value: amount.toFixed?amount.toFixed(2):String(amount) } }]
  });
  try{
    const order = await client.execute(request);
    res.json({ id: order.result.id });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Capture order
app.post('/capture-order', async (req, res) => {
  const { orderID } = req.body;
  if(!orderID) return res.status(400).json({ error: 'Missing orderID' });
  const request = new paypal.orders.OrdersCaptureRequest(orderID);
  request.requestBody({});
  try{
    const capture = await client.execute(request);
    // persist subscription (best-effort)
    try{
      const result = capture.result || {};
      const id = result.id || orderID;
      const payerEmail = (result.payer && result.payer.email_address) || '';
      const created = Date.now();
      db.run('INSERT OR REPLACE INTO subscriptions (id, email, provider, plan, status, tx_ref, created_at, raw) VALUES (?,?,?,?,?,?,?,?)', [id, payerEmail, 'paypal', 'pro', 'completed', id, created, JSON.stringify(result)], (err)=>{ if(err) console.error('DB insert',err); });
    }catch(e){ console.error('persist error', e); }
    res.json(capture.result);
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Capture failed' });
  }
});

// Basic webhook receiver (verify via PayPal webhook verification recommended)
app.post('/webhook', (req, res) => {
  // PayPal webhook verification
  const transmissionId = req.header('paypal-transmission-id');
  const transmissionTime = req.header('paypal-transmission-time');
  const certUrl = req.header('paypal-cert-url');
  const authAlgo = req.header('paypal-auth-algo');
  const transmissionSig = req.header('paypal-transmission-sig');
  const webhookId = process.env.PAYPAL_WEBHOOK_ID || '';
  if(!webhookId){
    console.warn('PAYPAL_WEBHOOK_ID not set; skipping verification');
    console.log('Webhook payload', req.body);
    return res.sendStatus(200);
  }

  const verifyReq = new paypal.notifications.VerifyWebhookSignatureRequest();
  verifyReq.requestBody({
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
    webhook_event: req.body
  });

  (async ()=>{
    try{
      const resp = await client.execute(verifyReq);
      const status = resp.result && resp.result.verification_status;
      if(status === 'SUCCESS'){
        // handle event
        console.log('Verified PayPal webhook:', req.body.event_type);
        // Example: PAYMENT.CAPTURE.COMPLETED -> persist subscription
        const ev = req.body;
        if(ev && ev.event_type && ev.event_type.indexOf('PAYMENT.CAPTURE.COMPLETED')!==-1){
          const data = ev.resource || {};
          const orderId = data.supplementary_data && data.supplementary_data.related_ids && data.supplementary_data.related_ids.order_id || (data.id||data.order_id);
          const subId = orderId || ('pp_'+Date.now());
          const created = Date.now();
          db.run('INSERT OR REPLACE INTO subscriptions (id, email, provider, plan, status, tx_ref, created_at, raw) VALUES (?,?,?,?,?,?,?,?)', [subId, (data.payer&&data.payer.email_address)||'', 'paypal', 'pro', 'completed', data.id||'', created, JSON.stringify(ev)], (err)=>{ if(err) console.error('DB insert',err); });
        }
        return res.sendStatus(200);
      }else{
        console.warn('PayPal webhook verification failed', status);
        return res.status(400).send('Invalid webhook signature');
      }
    }catch(err){
      console.error('Webhook verify error', err);
      return res.status(500).send('Verification error');
    }
  })();
});

// Flutterwave webhook endpoint (verifies verif-hash header)
app.post('/flutterwave/webhook', (req, res) => {
  const signature = req.header('verif-hash') || req.header('verif_hash');
  if(!FLW_SECRET){ console.warn('FLW_SECRET not set'); return res.sendStatus(200); }
  const expected = crypto.createHmac('sha256', FLW_SECRET).update(JSON.stringify(req.body)).digest('hex');
  if(!signature || signature !== expected){ console.warn('Invalid Flutterwave signature'); return res.status(400).send('Invalid signature'); }
  const ev = req.body;
  // Example: ev.data && ev.data.status === 'successful'
  const tx = ev && ev.data ? ev.data : {};
  const tx_ref = tx.tx_ref || '';
  const id = tx.id || ('fw_'+Date.now());
  const created = Date.now();
  const email = (tx.customer && tx.customer.email) || '';
  const status = (tx.status==='successful') ? 'completed' : (tx.status||'unknown');
  db.run('INSERT OR REPLACE INTO subscriptions (id, email, provider, plan, status, tx_ref, created_at, raw) VALUES (?,?,?,?,?,?,?,?)', [id, email, 'flutterwave', 'pro', status, tx_ref, created, JSON.stringify(ev)], (err)=>{ if(err) console.error('DB insert',err); });
  return res.sendStatus(200);
});

// --- Flutterwave endpoints ---
// Create a Flutterwave payment and return the redirect link
app.post('/flutterwave/create-payment', async (req, res) => {
  const { amount, currency, tx_ref, redirectUrl, email } = req.body;
  if (!amount || !tx_ref) return res.status(400).json({ error: 'Missing amount or tx_ref' });
  if (!FLW_SECRET) return res.status(500).json({ error: 'Flutterwave secret not configured' });
  try{
    const payload = {
      tx_ref: tx_ref,
      amount: amount.toFixed ? amount.toFixed(2) : String(amount),
      currency: currency || 'NGN',
      redirect_url: redirectUrl || (req.protocol + '://' + req.get('host') + '/'),
      customer: { email: email || 'guest@study.example' },
      payment_options: 'card,ussd',
      meta: { app: 'StudyMind' }
    };
    const r = await axios.post('https://api.flutterwave.com/v3/payments', payload, { headers: { Authorization: `Bearer ${FLW_SECRET}`, 'Content-Type': 'application/json' } });
    return res.json(r.data);
  }catch(err){
    console.error(err.response?err.response.data:err.message);
    return res.status(500).json({ error: 'Failed to create Flutterwave payment' });
  }
});

// Verify by tx_ref
app.get('/flutterwave/verify', async (req, res) => {
  const tx_ref = req.query.tx_ref || req.body.tx_ref;
  if(!tx_ref) return res.status(400).json({ error: 'Missing tx_ref' });
  if(!FLW_SECRET) return res.status(500).json({ error: 'Flutterwave secret not configured' });
  try{
    const r = await axios.get('https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(tx_ref), { headers: { Authorization: `Bearer ${FLW_SECRET}` } });
    // persist if successful
    if(r.data && r.data.status === 'success' && r.data.data){
      const tx = r.data.data;
      const id = tx.id || ('fw_'+Date.now());
      const created = Date.now();
      const email = (tx.customer && tx.customer.email) || '';
      const status = (tx.status==='successful') ? 'completed' : (tx.status||'unknown');
      db.run('INSERT OR REPLACE INTO subscriptions (id, email, provider, plan, status, tx_ref, created_at, raw) VALUES (?,?,?,?,?,?,?,?)', [id, email, 'flutterwave', 'pro', status, tx.tx_ref || tx_ref, created, JSON.stringify(r.data)], (err)=>{ if(err) console.error('DB insert',err); });
    }
    return res.json(r.data);
  }catch(err){
    console.error(err.response?err.response.data:err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// Admin: list subscriptions
// Admin auth: JWT-based login using ADMIN_PASSWORD and ADMIN_JWT_SECRET env vars.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || '';

// Login endpoint - exchange password for JWT
app.post('/admin/login', (req, res) => {
  const pass = req.body && req.body.password;
  if(!ADMIN_PASSWORD || !ADMIN_JWT_SECRET){
    return res.status(500).json({ error: 'Admin auth not configured on server' });
  }
  if(!pass) return res.status(400).json({ error: 'Missing password' });
  if(pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const token = jwt.sign({ sub: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '6h' });
  res.json({ token });
});

function verifyJwt(req, res, next){
  if(!ADMIN_JWT_SECRET){ console.warn('ADMIN_JWT_SECRET not set; admin endpoint is unprotected'); return next(); }
  const auth = req.header('authorization') || req.header('Authorization') || '';
  if(!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  const token = auth.split(' ')[1];
  try{
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    req.admin = decoded;
    return next();
  }catch(err){ return res.status(403).json({ error: 'Invalid or expired token' }); }
}

app.get('/admin/subscriptions', verifyJwt, (req, res) => {
  db.all('SELECT id,email,provider,plan,status,tx_ref,created_at FROM subscriptions ORDER BY created_at DESC LIMIT 200', [], (err, rows)=>{
    if(err) return res.status(500).json({ error: 'DB error' });
    res.json({ subscriptions: rows });
  });
});

const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log('Payment server listening on', port));
