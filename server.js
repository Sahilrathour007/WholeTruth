// ─────────────────────────────────────────────────
//  THE WHOLE TRUTH — BACKEND (Node.js / Express)
//  POST /order → validates → sends to Google Sheets
// ─────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ───────────────────────────────────
app.use(cors({
  origin: ["http://127.0.0.1:5500", "http://localhost:5500"],
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));
app.options("*", cors());
app.use(express.json());

// ── RATE LIMITER (FIX #8) ────────────────────────
// Prevents spam / Google Sheets quota exhaustion.
// Uses a simple in-process sliding-window counter — no extra dependency.
// For high-traffic deployments swap this out for express-rate-limit + Redis.
const rateLimitStore = new Map(); // ip → { count, windowStart }
const RATE_LIMIT_MAX    = 10;           // max requests …
const RATE_LIMIT_WINDOW = 60 * 1000;   // … per 60 seconds per IP

function isRateLimited(ip) {
  const now    = Date.now();
  const record = rateLimitStore.get(ip);

  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return false;
  }
  if (record.count >= RATE_LIMIT_MAX) return true;
  record.count++;
  return false;
}

// Clean up stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimitStore.entries()) {
    if (now - rec.windowStart > RATE_LIMIT_WINDOW) rateLimitStore.delete(ip);
  }
}, 5 * 60 * 1000);

// ── DUPLICATE ORDER STORE ────────────────────────
// FIX #1: Key is now name+phone only (order-level), not per-product.
//         A cart with 3 products is ONE order — the key must reflect that.
// FIX #2: Orders are registered BEFORE the async Sheets call so that
//         concurrent double-clicks are blocked even if the first request
//         hasn't returned yet. On failure we unregister so the user can retry.
const recentOrders = new Map(); // key → timestamp
const DEDUP_WINDOW = 30 * 1000; // 30 seconds

function buildDedupKey(name, phone) {
  return `${name.trim().toLowerCase()}::${String(phone).trim()}`;
}

function isDuplicateOrder(name, phone) {
  const last = recentOrders.get(buildDedupKey(name, phone));
  return !!last && Date.now() - last < DEDUP_WINDOW;
}

function registerOrder(name, phone) {
  recentOrders.set(buildDedupKey(name, phone), Date.now());
}

function unregisterOrder(name, phone) {
  recentOrders.delete(buildDedupKey(name, phone));
}

// Clean up old entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentOrders.entries()) {
    if (now - ts > 2 * 60 * 1000) recentOrders.delete(key);
  }
}, 2 * 60 * 1000);

// ── VALIDATORS ───────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateOrderItem(item) {
  const errors = [];

  if (!item.name || item.name.trim().length < 2)
    errors.push("Invalid name");

  // FIX #3: email is now validated server-side
  if (!item.email || !EMAIL_RE.test(item.email.trim()))
    errors.push("Invalid email address");

  // FIX #10: coerce to string before regex + trim
  if (!/^\d{10}$/.test(String(item.phone || "").trim()))
    errors.push("Invalid phone number (must be 10 digits)");

  if (!item.city || item.city.trim().length < 2)
    errors.push("Invalid city");

  if (!item.address || item.address.trim().length < 10)
    errors.push("Invalid address (too short)");

  if (!item.product_name || !item.product_name.trim())
    errors.push("Missing product name");

  // FIX #9: cast to Number and validate
  const val = Number(item.order_value);
  if (!item.order_value || isNaN(val) || val <= 0)
    errors.push("Invalid order value");

  // FIX #4: validate quantity if provided
  if (item.quantity !== undefined) {
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100)
      errors.push("Invalid quantity (must be a whole number between 1 and 100)");
  }

  return errors;
}

// ── ROUTES ───────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "The Whole Truth API" });
});

// POST /order
app.post("/order", async (req, res) => {

  // FIX #8: rate limit by IP before doing anything else
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  if (isRateLimited(clientIp)) {
    return res.status(429).json({
      success: false,
      message: "Too many requests. Please slow down and try again shortly.",
    });
  }

  const { orders } = req.body;

  // Validate structure
  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ success: false, message: "No orders provided." });
  }

  // Validate each order item
  const allErrors = [];
  orders.forEach((item, i) => {
    const errs = validateOrderItem(item);
    if (errs.length) allErrors.push(`Item ${i + 1}: ${errs.join(", ")}`);
  });

  if (allErrors.length) {
    return res.status(400).json({ success: false, message: allErrors.join(" | ") });
  }

  // FIX #1: Dedup check at order level (name+phone), not per-product
  const { name, phone } = orders[0];
  if (isDuplicateOrder(name, phone)) {
    return res.status(409).json({
      success: false,
      message: "It looks like this order was already submitted. Please wait 30 seconds before trying again.",
    });
  }

  // FIX #7: Read env var at request time, not module load time
  const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
  if (!GOOGLE_SCRIPT_URL) {
    console.error("[CONFIG ERROR] GOOGLE_SCRIPT_URL is not set.");
    return res.status(500).json({
      success: false,
      message: "Server configuration error. Please contact support.",
    });
  }

  // Build payload rows for Google Sheets
  const orderDate = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const rows = orders.map(item => ({
    order_date:    orderDate,
    name:          item.name.trim(),
    email:         item.email.trim(),                   // FIX #3: always present now
    phone:         String(item.phone).trim(),            // FIX #10: safe string coercion
    city:          item.city.trim(),
    address:       item.address.trim(),
    product_name:  item.product_name.trim(),
    quantity:      Number(item.quantity) || 1,
    order_value:   Number(item.order_value),             // FIX #9: stored as Number
    return_status: "No",
    utm_source:    item.utm_source   || "organic",
    utm_medium:    item.utm_medium   || "",
    utm_campaign:  item.utm_campaign || "",
  }));

  // FIX #2: Register BEFORE the async call to block concurrent duplicates.
  //         If Sheets fails we unregister so the user can retry legitimately.
  registerOrder(name, phone);

  // Send to Google Sheets
  try {
    const sheetsRes = await axios.post(GOOGLE_SCRIPT_URL, { rows }, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    if (sheetsRes.data?.status !== "success") {
      throw new Error("Google Sheets returned non-success: " + JSON.stringify(sheetsRes.data));
    }

    console.log(`[ORDER] ✓ ${rows.length} item(s) | ${rows[0].name} | ${rows[0].phone} | ₹${rows.reduce((s, r) => s + r.order_value, 0)} | ${orderDate}`);

    return res.status(200).json({
      success:     true,
      message:     "Order placed successfully!",
      order_count: rows.length,
    });

  } catch (err) {
    // FIX #2: Unregister on failure so the user can retry
    unregisterOrder(name, phone);

    console.error("[ORDER ERROR]", err.message || err);

    // FIX #5: Honest error message — don't tell the user we received
    //         the order if we actually failed to log it
    return res.status(500).json({
      success: false,
      message: "Your order could not be placed due to a server error. Please try again or contact support.",
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Endpoint not found." });
});

// ── START ────────────────────────────────────────
app.listen(PORT, () => {
  const sheetsConfigured = !!process.env.GOOGLE_SCRIPT_URL;
  console.log(`\n🌿 The Whole Truth API running on http://localhost:${PORT}`);
  console.log(`   Sheets URL configured: ${sheetsConfigured ? "✓ Yes" : "✗ No — set GOOGLE_SCRIPT_URL in .env"}\n`);
  if (!sheetsConfigured) {
    console.warn("   ⚠️  Orders will fail until GOOGLE_SCRIPT_URL is set.\n");
  }
});