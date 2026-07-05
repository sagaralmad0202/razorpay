const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT_DIR, "build");
const ENV_FILE = path.join(ROOT_DIR, ".env");
const MAX_BODY_BYTES = 1024 * 1024;
const ORDER_TTL_MS = 30 * 60 * 1000;

const issuedOrders = new Map();

loadEnvFile(ENV_FILE);

const PORT = Number(process.env.API_PORT || process.env.PORT || 5000);
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID; // Public Checkout key ID, safe to send to the browser.
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET; // Secret key, server-only.
const CURRENCY = process.env.RAZORPAY_CURRENCY || "INR";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Razorpay Store";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    await handleApiRequest(req, res, requestUrl);
    return;
  }

  serveStaticFile(req, res, requestUrl);
});

server.on("error", handleServerError);

server.listen(PORT, () => {
  console.log(`Payment server running at http://localhost:${PORT}`);
});

function handleServerError(error) {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. The payment server may already be running at http://localhost:${PORT}.`
    );
    console.error("Stop the existing server before starting another one, or change API_PORT in .env.");
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
}

async function handleApiRequest(req, res, requestUrl) {
  setApiCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/orders") {
    await createOrder(req, res);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/payments/verify") {
    await verifyPayment(req, res);
    return;
  }

  sendJson(res, 404, { message: "API route not found." });
}

function setApiCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function createOrder(req, res) {
  try {
    ensureRazorpayKeys();

    const body = await readJsonBody(req);
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

    pruneIssuedOrders();
    issuedOrders.set(order.id, {
      amount: order.amount,
      createdAt: Date.now(),
      currency: order.currency,
      receipt: order.receipt,
    });

    sendJson(res, 200, {
      amount: order.amount,
      businessName: BUSINESS_NAME,
      currency: order.currency,
      id: order.id,
      keyId: RAZORPAY_KEY_ID,
      receipt: order.receipt,
    });
  } catch (error) {
    sendError(res, error, "Unable to create Razorpay order.");
  }
}

async function verifyPayment(req, res) {
  try {
    ensureRazorpayKeys();

    const body = await readJsonBody(req);
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

    if (!issuedOrders.has(expectedOrderId)) {
      throw publicError("Order was not created by this server session.", 400);
    }

    const generatedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${expectedOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (!safeCompare(generatedSignature, razorpaySignature)) {
      throw publicError("Payment signature verification failed.", 400);
    }

    issuedOrders.delete(expectedOrderId);

    sendJson(res, 200, {
      orderId: expectedOrderId,
      paymentId: razorpayPaymentId,
      verified: true,
    });
  } catch (error) {
    sendError(res, error, "Unable to verify payment.");
  }
}

async function createRazorpayOrder(orderPayload) {
  const credentials = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");

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
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw publicError(
      "Razorpay keys are not configured. Copy .env.example to .env and add your keys.",
      500
    );
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > MAX_BODY_BYTES) {
        reject(publicError("Request body is too large.", 413));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(publicError("Request body must be valid JSON.", 400, error));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });

  if (statusCode === 204) {
    res.end();
    return;
  }

  res.end(JSON.stringify(payload));
}

function sendError(res, error, fallbackMessage) {
  const statusCode = error.statusCode || 500;
  const message = error.expose ? error.message : fallbackMessage;

  if (!error.expose) {
    console.error(error);
  }

  sendJson(res, statusCode, { message });
}

function publicError(message, statusCode, cause) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  error.cause = cause;
  return error;
}

function safeCompare(value, expectedValue) {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expectedValue);

  if (valueBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

function pruneIssuedOrders() {
  const expiresBefore = Date.now() - ORDER_TTL_MS;

  for (const [orderId, order] of issuedOrders) {
    if (order.createdAt < expiresBefore) {
      issuedOrders.delete(orderId);
    }
  }
}

function serveStaticFile(req, res, requestUrl) {
  if (!fs.existsSync(BUILD_DIR)) {
    sendHtml(
      res,
      200,
      "<h1>React build not found</h1><p>Run npm run build, then npm run serve. For development, run npm run server and npm start.</p>"
    );
    return;
  }

  const requestedPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const filePath = path.resolve(BUILD_DIR, relativePath);

  if (!isInsideBuildDir(filePath)) {
    sendHtml(res, 403, "<h1>Forbidden</h1>");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      const fallbackPath = path.join(BUILD_DIR, "index.html");

      fs.readFile(fallbackPath, (fallbackError, fallbackData) => {
        if (fallbackError) {
          sendHtml(res, 404, "<h1>Not found</h1>");
          return;
        }

        res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
        res.end(fallbackData);
      });

      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    });
    res.end(data);
  });
}

function isInsideBuildDir(filePath) {
  const normalizedBuildDir = `${path.resolve(BUILD_DIR).toLowerCase()}${path.sep}`;
  const normalizedFilePath = path.resolve(filePath).toLowerCase();
  return normalizedFilePath.startsWith(normalizedBuildDir);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body>${html}</body></html>`);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

