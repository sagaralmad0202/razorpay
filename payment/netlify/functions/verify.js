const crypto = require("crypto");

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
    const expectedOrderId = String(body.order_id || "");
    const razorpayOrderId = String(body.razorpay_order_id || "");
    const razorpayPaymentId = String(body.razorpay_payment_id || "");
    const razorpaySignature = String(body.razorpay_signature || "");

    if (!expectedOrderId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      throw publicError("Missing Razorpay payment verification fields.", 400);
    }

    if (expectedOrderId !== razorpayOrderId) {
      throw publicError("Razorpay order id does not match the created order.", 400);
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${expectedOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (!safeCompare(generatedSignature, razorpaySignature)) {
      throw publicError("Payment signature verification failed.", 400);
    }

    return jsonResponse(200, {
      orderId: expectedOrderId,
      paymentId: razorpayPaymentId,
      verified: true,
    });
  } catch (error) {
    return errorResponse(error, "Unable to verify payment.");
  }
};

function ensureRazorpayKeys() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw publicError("Razorpay keys are not configured in Netlify environment variables.", 500);
  }
}

function readJsonBody(rawBody) {
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw publicError("Request body must be valid JSON.", 400, error);
  }
}

function safeCompare(value, expectedValue) {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expectedValue);

  if (valueBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(valueBuffer, expectedBuffer);
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