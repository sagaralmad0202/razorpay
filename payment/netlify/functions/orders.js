const crypto = require("crypto");

const CURRENCY = process.env.RAZORPAY_CURRENCY || "INR";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Razorpay Store";
const MAX_BODY_BYTES = 1024 * 1024;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {});
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { message: "Method not allowed." });
  }

  try {
    ensureRazorpayKeys();

    const body = readJsonBody(event.body || "");
    const amount = normalizeAmountToSubunits(body.amount);
    const receipt = createReceiptId();
    const customer = body.customer || {};

    const order = await createRazorpayOrder({
      amount,
      currency: CURRENCY,
      receipt,
      notes: {
        customer_name: String(customer.name || "").slice(0, 256),
        customer_email: String(customer.email || "").slice(0, 256),
      },
    });

    return jsonResponse(200, {
      amount: order.amount,
      businessName: BUSINESS_NAME,
      currency: order.currency,
      id: order.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      receipt: order.receipt,
    });
  } catch (error) {
    return errorResponse(error, "Unable to create Razorpay order.");
  }
};

async function createRazorpayOrder(orderPayload) {
  const credentials = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
  ).toString("base64");

  let response;
  try {
    response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderPayload),
    });
  } catch (error) {
    throw publicError(
      "Could not reach Razorpay. Check your internet connection and API keys.",
      502,
      error
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const description = data.error?.description || data.message || "Razorpay rejected the order.";
    throw publicError(description, response.status);
  }

  return data;
}

function ensureRazorpayKeys() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw publicError("Razorpay keys are not configured in Netlify environment variables.", 500);
  }
}

function normalizeAmountToSubunits(amount) {
  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedAmount)) {
    throw publicError("Enter a valid amount.", 400);
  }

  const subunits = Math.round(parsedAmount * 100);

  if (subunits < 100) {
    throw publicError("Amount must be at least INR 1.00.", 400);
  }

  return subunits;
}

function createReceiptId() {
  const randomValue = crypto.randomBytes(4).toString("hex");
  return `rcpt_${Date.now()}_${randomValue}`.slice(0, 40);
}

function readJsonBody(rawBody) {
  if (rawBody.length > MAX_BODY_BYTES) {
    throw publicError("Request body is too large.", 413);
  }

  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw publicError("Request body must be valid JSON.", 400, error);
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: statusCode === 204 ? "" : JSON.stringify(payload),
  };
}

function errorResponse(error, fallbackMessage) {
  const statusCode = error.statusCode || 500;
  const message = error.expose ? error.message : fallbackMessage;

  if (!error.expose) {
    console.error(error);
  }

  return jsonResponse(statusCode, { message });
}

function publicError(message, statusCode, cause) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  error.cause = cause;
  return error;
}