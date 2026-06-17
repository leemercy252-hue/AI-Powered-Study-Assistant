const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const paypal = require('@paypal/checkout-server-sdk');

// Configure PayPal environment using env vars
// PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=(sandbox|live)
const clientId = process.env.PAYPAL_CLIENT_ID || '';
const clientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
const envName = (process.env.PAYPAL_ENV || 'sandbox');

let environment = envName === 'live' ? new paypal.core.LiveEnvironment(clientId, clientSecret) : new paypal.core.SandboxEnvironment(clientId, clientSecret);
let client = new paypal.core.PayPalHttpClient(environment);

const FLW_SECRET = process.env.FLW_SECRET_KEY || ''; // Flutterwave secret key

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => res.send('Payment server running'));

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
    res.json(capture.result);
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Capture failed' });
  }
});

// Basic webhook receiver (verify via PayPal webhook verification recommended)
app.post('/webhook', (req, res) => {
  console.log('Webhook received', req.body);
  // TODO: verify signature and handle events
  res.sendStatus(200);
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
    return res.json(r.data);
  }catch(err){
    console.error(err.response?err.response.data:err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log('Payment server listening on', port));
