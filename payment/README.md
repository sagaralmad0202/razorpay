# Razorpay Payment Application

React checkout UI with a small Node backend for Razorpay Standard Checkout.

The app follows Razorpay's recommended flow:

1. Create an order on the server.
2. Open Razorpay Checkout when the user clicks Pay.
3. Verify the returned payment signature on the server.

## Setup

Create a `.env` file from the example and add your Razorpay test keys:

```bash
copy .env.example .env
```

```env
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_key_secret
RAZORPAY_CURRENCY=INR
BUSINESS_NAME=Razorpay Store
API_PORT=5000
```

Use Test Mode keys while testing. Switch to Live Mode keys only after your Razorpay account, payment capture settings, and webhook handling are ready.

`RAZORPAY_KEY_ID` is the public Checkout key ID and is sent to the browser so Razorpay Checkout can open. `RAZORPAY_KEY_SECRET` is server-only and must never be returned from API responses or added to React `REACT_APP_*` variables.

## Development

Run the API server from the project root:

```bash
npm run server
```

Or from `payment/server`:

```bash
npm start
```

In another terminal at the project root, run the React app:

```bash
npm start
```

Open `http://localhost:3000`. The React dev server proxies `/api` calls to `http://localhost:5000`.

## Production Preview

Build React and serve it from the Node server:

```bash
npm run build
npm run serve
```

Open `http://localhost:5000`.

## Testing Payments

Razorpay Test Mode supports simulated payment methods. For UPI, use `success@razorpay` for a successful test payment and `failure@razorpay` for a failed payment.

## Important Notes

The sample server stores created order IDs in memory so it can verify the current checkout session. For production, persist orders and payment state in your database.

Always verify the Razorpay signature on the server before fulfilling an order. For live payments, also configure Razorpay webhooks and confirm the payment is captured.

Official docs:

- Razorpay Web Standard Checkout: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Razorpay Orders API: https://razorpay.com/docs/api/orders/create/
