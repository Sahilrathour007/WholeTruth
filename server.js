// ─────────────────────────────────────────────────
//  THE WHOLE TRUTH — BACKEND (Node.js / Express)
//  POST /order → validates → sends to Google Sheets
// ─────────────────────────────────────────────────

const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ───────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*", // Set your frontend URL in production
  methods: ["POST", "GET"],
}));
app.use(express.json());

// ── CONFIG ───────────────────────────────────────
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
// Paste your deployed Google Apps Script Web App URL in .env as GOOGLE_SCRIPT_URL

// ── DUPLICATE ORDER STORE (in-memory, 5min window) ──
const recentOrders = new Map(); // key → timestamp

function buildDedupKey(name, phone, productName) {
  return `${name.toLowerCase()}::${phone}::${productName.toLowerCase()}`;
}

function isDuplicateOrder(name, phone, productName) {
  const key = buildDedupKey(name, phone, productName);
  const last = recentOrders.get(key);
  if (last && Date.now() - last < 5 * 60 * 1000) return true;
  return false;
}

function registerOrder(name, phone, productName) {
  const key = buildDedupKey(name, phone, productName);
  recentOrders.set(key, Date.now());
}

// Clean up old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentOrders.entries()) {
    if (now - ts > 10 * 60 * 1000) recentOrders.delete(key);
  }
}, 10 * 60 * 1000);

// ── VALIDATORS ───────────────────────────────────
function validateOrderItem(item) {
  const errors = [];
  if (!item.name || item.name.trim().length < 2) errors.push("Invalid name");
  if (!/^\d{10}$/.test(item.phone)) errors.push("Invalid phone number");
  if (!item.city || item.city.trim().length < 2) errors.push("Invalid city");
  if (!item.address || item.address.trim().length < 10) errors.push("Invalid address");
  if (!item.product_name) errors.push("Missing product name");
  if (!item.order_value || isNaN(item.order_value) || item.order_value <= 0) errors.push("Invalid order value");
  return errors;
}

// ── ROUTES ───────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "The Whole Truth API" });
});

// POST /order
app.post("/order", async (req, res) => {
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

  // Duplicate check
  const duplicates = orders.filter(item =>
    isDuplicateOrder(item.name, item.phone, item.product_name)
  );
  if (duplicates.length > 0) {
    return res.status(409).json({
      success: false,
      message: "Duplicate order detected. Please wait before resubmitting.",
    });
  }

  // Build payload rows for Google Sheets
  const orderDate = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const rows = orders.map(item => ({
    order_date:   orderDate,
    name:         item.name.trim(),
    email:        item.email ? item.email.trim() : "",  // ← ADDED
    phone:        item.phone.trim(),
    city:         item.city.trim(),
    address:      item.address.trim(),
    product_name: item.product_name.trim(),
    quantity:     item.quantity || 1,
    order_value:  item.order_value,
    return_status: "No",
  }));

  // Send to Google Sheets
  try {
    if (!GOOGLE_SCRIPT_URL) throw new Error("GOOGLE_SCRIPT_URL not configured");

    const sheetsRes = await axios.post(GOOGLE_SCRIPT_URL, { rows }, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    if (sheetsRes.data?.status !== "success") {
      throw new Error("Google Sheets returned non-success: " + JSON.stringify(sheetsRes.data));
    }

    // Register orders for dedup
    orders.forEach(item => registerOrder(item.name, item.phone, item.product_name));

    console.log(`[ORDER] ✓ ${rows.length} row(s) submitted by ${rows[0].name} at ${orderDate}`);

    return res.status(200).json({
      success: true,
      message: "Order placed successfully!",
      order_count: rows.length,
    });

  } catch (err) {
    // Log error but don't expose internals to client
    console.error("[ORDER ERROR]", err.message || err);

    return res.status(500).json({
      success: false,
      message: "We received your order but had a logging issue. Please contact support if not confirmed.",
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Endpoint not found." });
});

// ── START ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌿 The Whole Truth API running on http://localhost:${PORT}`);
  console.log(`   Sheets URL configured: ${GOOGLE_SCRIPT_URL ? "✓ Yes" : "✗ No — set GOOGLE_SCRIPT_URL in .env"}\n`);
});