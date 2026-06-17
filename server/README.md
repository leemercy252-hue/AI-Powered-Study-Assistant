PayPal Server for StudyMind

This minimal server provides endpoints to create and capture PayPal orders using the PayPal Checkout Server SDK.

Environment variables (set these for production):

- PAYPAL_CLIENT_ID - your PayPal REST app client id (live)
- PAYPAL_CLIENT_SECRET - your PayPal REST app secret (live)
- PAYPAL_ENV - 'live' or 'sandbox'

Install and run:

```bash
cd server
npm install
PAYPAL_CLIENT_ID=your_id PAYPAL_CLIENT_SECRET=your_secret PAYPAL_ENV=sandbox npm start
```

Endpoints:

- POST /create-order { amount: number, currency: 'EUR'|'USD' } -> { id }
- POST /capture-order { orderID: string } -> capture result
- POST /webhook -> receive PayPal webhook events (verify signature before trusting)

Flutterwave
--------

- POST /flutterwave/create-payment { amount: number, currency: string, tx_ref: string, redirectUrl?: string, email?: string } -> returns Flutterwave payment response (contains redirect link)
- GET /flutterwave/verify?tx_ref=YOUR_TX_REF -> returns verification result

Environment variables:
- FLW_SECRET_KEY - your Flutterwave secret key

Example create-payment request (server-side):

```bash
curl -X POST https://your-server.example.com/flutterwave/create-payment \
	-H 'Content-Type: application/json' \
	-d '{"amount":4.99,"currency":"NGN","tx_ref":"sm_12345","redirectUrl":"https://your-site.example.com/success","email":"user@uni.edu"}'
```

Notes:
- Flutterwave returns a `data.link` which you should redirect the user to.
- Verify payment by calling `/flutterwave/verify?tx_ref=...` after redirect.
- Use HTTPS and secure env vars in production.

Notes:
- Use this server behind HTTPS in production.
- Implement webhook signature verification: https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature
- For subscriptions use Billing API instead of simple orders.
