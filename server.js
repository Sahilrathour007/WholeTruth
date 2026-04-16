// =============================================================
//  THE WHOLE TRUTH — BACKEND v4.6
//  WHAT CHANGED FROM v4.4:
//  [BUG FIX] /habit/signup had 3 compounding errors:
//      1. duplicate `const resolvedOrderId` declaration → SyntaxError, entire route crashes
//      2. `generateHabitPlan()` call was deleted → planResult undefined
//      3. `planResult.planId` referenced before planResult existed → runtime crash
//      → Fix: removed duplicate declaration, restored generateHabitPlan() call,
//             UUID_REGEX guard kept as single correct declaration
// =============================================================

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const { generateHabitPlan, adaptTodayTask, retryDeadLetters } = require('./habitEngine');

require('dotenv').config();

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL    = process.env.RESEND_FROM_EMAIL;
const CRON_SECRET          = process.env.CRON_SECRET;
const GOOGLE_SCRIPT_URL    = process.env.GOOGLE_SCRIPT_URL;
const TRACKER_GAS_URL      = process.env.TRACKER_GAS_URL;

const app      = express();
const PORT     = process.env.PORT || 3000;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const resend   = new Resend(RESEND_API_KEY);

// ── SCHEMA VALIDATOR ──────────────────────────────────────────
const REQUIRED_SCHEMA = {
  order_items: [
    'id', 'user_id', 'order_id', 'product_name', 'category',
    'quantity', 'unit_price', 'order_value', 'utm_source', 'utm_medium',
    'utm_campaign', 'order_date', 'created_at'
  ],
  orders: [
    'id', 'user_id', 'order_id', 'total', 'created_at'
  ],
  users: [
    'id', 'name', 'email', 'phone', 'city', 'source'
  ],
  events: [
    'id', 'user_id', 'event_type', 'metadata', 'created_at'
  ],
  habit_tasks: [
    'id', 'plan_id', 'user_id', 'day_number', 'task_type',
    'description', 'status', 'scheduled_date', 'primary_product',
    'dosage_label', 'completion_type', 'completed_at', 'email_sent_at'
  ],
};

async function validateSchema() {
  console.log('[SCHEMA] Validating database schema...');
  let allOk = true;

  for (const [table, requiredCols] of Object.entries(REQUIRED_SCHEMA)) {
    const missingCols = [];

    for (const col of requiredCols) {
      const { error: colErr } = await supabase
        .from(table)
        .select(col)
        .limit(0);

      if (colErr) {
        missingCols.push(`${col} (${colErr.message})`);
        allOk = false;
      }
    }

    if (missingCols.length > 0) {
      console.error(`❌ [SCHEMA] ${table} — MISSING COLUMNS: ${missingCols.join(', ')}`);
    } else {
      console.log(`✅ [SCHEMA] ${table}: all columns present`);
    }
  }

  if (!allOk) {
    console.error('\n[SCHEMA] ⚠️  SCHEMA MISMATCHES DETECTED — some inserts WILL fail!\n');
  } else {
    console.log('[SCHEMA] All tables validated ✅\n');
  }
}

validateSchema();

app.use(cors({
  origin:  process.env.ALLOWED_ORIGIN || '*',
  methods: ['POST', 'GET', 'OPTIONS'],
}));
app.use(express.json());

// ── SERVER READY GUARD ────────────────────────────────────────
let serverReady = false;
setTimeout(() => {
  serverReady = true;
  console.log('[INIT] Server ready flag set — cron jobs now accepted');
}, 15000);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ── DUPLICATE ORDER STORE ─────────────────────────────────────
const recentOrders = new Map();
function buildDedupKey(name, phone, productName) {
  return `${name.toLowerCase()}::${phone}::${productName.toLowerCase()}`;
}
function isDuplicateOrder(name, phone, productName) {
  const key  = buildDedupKey(name, phone, productName);
  const last = recentOrders.get(key);
  return last && Date.now() - last < 5 * 60 * 1000;
}
function registerOrder(name, phone, productName) {
  recentOrders.set(buildDedupKey(name, phone, productName), Date.now());
}
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentOrders.entries()) {
    if (now - ts > 10 * 60 * 1000) recentOrders.delete(key);
  }
}, 10 * 60 * 1000);

// ── VALIDATORS ────────────────────────────────────────────────
function validateOrderItem(item) {
  const errors = [];
  if (!item.name || item.name.trim().length < 2)         errors.push('Invalid name');
  if (!/^\d{10}$/.test(item.phone))                      errors.push('Invalid phone number');
  if (!item.city || item.city.trim().length < 2)         errors.push('Invalid city');
  if (!item.address || item.address.trim().length < 10)  errors.push('Invalid address');
  if (!item.product_name)                                 errors.push('Missing product name');
  if (!item.order_value || isNaN(item.order_value) || item.order_value <= 0)
                                                          errors.push('Invalid order value');
  return errors;
}

// ── PRODUCT NAME → CANONICAL CATEGORY ───────────────────────
// PERMANENT FIX: Never trust category from the frontend.
// Derive it from product_name on the backend at write time.
// This is the single source of truth for all downstream logic
// (habitEngine → taskTemplates → email content).
// If you add a new product, add it here. Nowhere else.
const PRODUCT_NAME_TO_CATEGORY = {
  // ── Whey variants ──────────────────────────────────────────────
  'whey':                    'whey',
  'whey protein':            'whey',
  'alpino whey':             'whey',
  'alpino whey protein':     'whey',
  'whey protein powder':     'whey',
  'alpino whey protein powder': 'whey',
  'whey isolate':            'whey',
  'whey concentrate':        'whey',

  // ── Peanut butter variants ──────────────────────────────────────
  'peanut butter':             'peanut_butter',
  'alpino peanut butter':      'peanut_butter',
  'crunchy peanut butter':     'peanut_butter',
  'smooth peanut butter':      'peanut_butter',
  'natural peanut butter':     'peanut_butter',
  'pb':                        'peanut_butter',
  'peanut butter powder':      'peanut_butter',

  // ── Protein bar variants ────────────────────────────────────────
  'protein bar':               'protein_bar',
  'alpino protein bar':        'protein_bar',
  'choco protein bar':         'protein_bar',
  'chocolate protein bar':     'protein_bar',
  'peanut butter protein bar': 'protein_bar',
  'energy bar':                'protein_bar',
  'nutrition bar':             'protein_bar',

  // ── Muesli variants (including common misspellings) ─────────────
  'muesli':                    'muesli',
  'museli':                    'muesli',   // FIX: common misspelling
  'mueseli':                   'muesli',   // FIX: common misspelling
  'alpino muesli':             'muesli',
  'alpino museli':             'muesli',   // FIX: misspelled brand variant
  'fruit muesli':              'muesli',
  'crunchy muesli':            'muesli',
  'oat muesli':                'muesli',
  'breakfast muesli':          'muesli',
};

function deriveCategory(productName) {
  if (!productName) return '';
  const key = productName.trim().toLowerCase();
  // Exact match first
  if (PRODUCT_NAME_TO_CATEGORY[key]) return PRODUCT_NAME_TO_CATEGORY[key];
  // Substring match fallback
  for (const [pattern, category] of Object.entries(PRODUCT_NAME_TO_CATEGORY)) {
    if (key.includes(pattern)) return category;
  }
  // Last resort — log it so you know to add it to the map
  console.warn(`[ORDER] Unknown product name, category blank: ${productName} — add to PRODUCT_NAME_TO_CATEGORY`);
  return '';
}

// ── IST DATE HELPER ───────────────────────────────────────────
function getISTDate(daysOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// ── EMAIL BUILDERS ────────────────────────────────────────────
function buildConfirmationEmail({ name, email, phone, city, address, items, total, displayOrderId, isReorder }) {
  const itemRows = items.map(item =>
    `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">${item.product_name}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;text-align:right;">
        ${item.quantity} x Rs.${(item.order_value / item.quantity).toFixed(0)} = Rs.${item.order_value}
      </td>
    </tr>`
  ).join('');

  const reorderNote = isReorder
    ? `<p style="color:#1D9E75;font-weight:500;margin-bottom:16px;">This was a reorder from your reminder — great timing!</p>`
    : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <div style="max-width:520px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:#1a1a1a;padding:20px 28px;">
      <span style="color:#fff;font-size:12px;font-weight:700;letter-spacing:4px;">THE WHOLE TRUTH</span>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 6px;">Order Confirmed!</h2>
      <p style="color:#888;margin:0 0 20px;font-size:14px;">Order ID: ${displayOrderId}</p>
      ${reorderNote}
      <p>Hey <strong>${name}</strong>, here's what's coming:</p>
      <table style="width:100%;border-collapse:collapse;font-size:15px;">${itemRows}
        <tr><td style="padding:14px 0;font-weight:700;">Total</td>
            <td style="padding:14px 0;font-weight:700;text-align:right;">Rs.${total}</td></tr>
      </table>
      <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin-top:20px;font-size:14px;line-height:1.7;">
        <strong>Delivery to:</strong><br>${name} - ${phone}<br>${city}<br>${address}
      </div>
      <p style="font-size:13px;color:#aaa;margin-top:24px;">
        We'll contact you on <strong>${phone}</strong> to confirm delivery timing.<br>Real food. No lies.
      </p>
    </div>
  </div></body></html>`;
}

function buildDailyTaskEmailHTML({ userName, taskDescription, taskType, dayNumber, completionUrl, streak, primaryProduct, dosageLabel }) {
  const typeConfig = {
    easy:       { emoji: '🌿', label: 'Easy Day',       color: '#2A9D8F' },
    push:       { emoji: '💪', label: 'Push Day',       color: '#E76F51' },
    push_high:  { emoji: '🔥', label: 'Push Day',       color: '#E76F51' },
    recovery:   { emoji: '🔄', label: 'Recovery Day',   color: '#4A9EFF' },
    reflection: { emoji: '🏆', label: 'Reflection Day', color: '#7C6FCD' },
    comeback:   { emoji: '🔁', label: 'Comeback Day',   color: '#E9C46A' },
    normal:     { emoji: '✅', label: 'Day ' + dayNumber, color: '#1D9E75' },
  };

  const PRODUCT_HEADING = {
    peanut_butter: 'Your peanut butter habit — Day',
    protein_bar:   'Your protein bar habit — Day',
    whey:          'Your protein shake habit — Day',
    muesli:        'Your muesli habit — Day',
  };

  const headingBase = primaryProduct && PRODUCT_HEADING[primaryProduct]
    ? `${PRODUCT_HEADING[primaryProduct]} ${dayNumber}`
    : `Day ${dayNumber} — Your Habit Task`;

  const cfg = typeConfig[taskType] || typeConfig.normal;
  const streakBadge = streak > 0
    ? `<div style="background:#FFF3E0;border-radius:6px;padding:8px 12px;margin-bottom:16px;font-size:13px;color:#E76F51;">${streak}-day streak — keep it going</div>`
    : '';

  const dosagePill = dosageLabel
    ? `<div style="display:inline-block;background:#1a1a1a;color:#fff;font-size:12px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:20px;margin-bottom:16px;">${dosageLabel}</div>`
    : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F6F1E9;font-family:Arial,sans-serif;">
  <div style="max-width:520px;margin:24px auto;background:#FDFAF5;border:1px solid #D8CEBC;border-radius:12px;overflow:hidden;">
    <div style="background:#1a1a1a;padding:16px 28px;">
      <span style="color:#fff;font-size:12px;font-weight:700;letter-spacing:4px;">THE WHOLE TRUTH HABIT ENGINE</span>
    </div>
    <div style="padding:28px;">
      ${streakBadge}
      <div style="background:${cfg.color}15;border-left:3px solid ${cfg.color};padding:8px 14px;margin-bottom:20px;font-size:12px;font-weight:700;color:${cfg.color};letter-spacing:2px;text-transform:uppercase;">
        ${cfg.emoji} ${cfg.label}
      </div>
      <h2 style="margin:0 0 8px;font-size:20px;color:#1C1C1A;">${headingBase}</h2>
      ${dosagePill}
      <div style="background:#E4F0E8;border-left:3px solid #2A6640;padding:16px 20px;font-size:15px;color:#1D4D2E;line-height:1.7;white-space:pre-line;margin:16px 0;">
${taskDescription}
      </div>
      <a href="${completionUrl}" style="display:block;text-align:center;background:#1a1a1a;color:#fff;padding:14px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;margin-top:20px;">
        Mark as Done
      </a>
      <p style="font-size:12px;color:#8A8780;text-align:center;margin-top:12px;">
        Click when you complete today's habit. Takes 2 seconds.
      </p>
    </div>
  </div></body></html>`;
}

function buildRecoveryEmailHTML({ userName, dayNumber }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F6F1E9;font-family:Arial,sans-serif;">
  <div style="max-width:520px;margin:24px auto;background:#FDFAF5;border:1px solid #D8CEBC;border-radius:12px;overflow:hidden;">
    <div style="background:#1a1a1a;padding:16px 28px;">
      <span style="color:#fff;font-size:12px;font-weight:700;letter-spacing:4px;">THE WHOLE TRUTH HABIT ENGINE</span>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 12px;font-size:20px;">Hey ${userName} — you missed a day.</h2>
      <p style="color:#4A4845;line-height:1.7;font-size:15px;">
        That's okay. Missing one day doesn't erase your progress.<br><br>
        Tomorrow we'll send you an easier version of Day ${dayNumber}. Just show up.
      </p>
      <div style="background:#FFF3E0;border-left:3px solid #E76F51;padding:14px 18px;margin-top:20px;font-size:14px;color:#7A4510;">
        Your plan has been adjusted. No catch-up required.
      </div>
    </div>
  </div></body></html>`;
}

// ── CRON GUARD ────────────────────────────────────────────────
function cronGuard(req, res, next) {
  if (req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function workerGuard(req, res, next) {
  if (req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── SEND DAY 1 TASK EMAIL ─────────────────────────────────────
async function sendDay1TaskEmail(userId, userEmail, userName) {
  const today = getISTDate(0);

  const { data: activePlan } = await supabase
    .from('habit_plans')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('start_date', { ascending: false })
    .limit(1)
    .single();

  if (!activePlan) {
    throw new Error(`No active plan found for user ${userId}`);
  }

  const { data: task, error: taskErr } = await supabase
    .from('habit_tasks')
    .select('id, day_number, description, task_type, status, primary_product, dosage_label')
    .eq('plan_id', activePlan.id)
    .eq('day_number', 1)
    .in('status', ['pending', 'sent'])
    .single();

  if (taskErr || !task) {
    throw new Error(`Day 1 task not found for plan ${activePlan.id}: ${taskErr?.message}`);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 48 * 3_600_000).toISOString();

  await supabase.from('completion_tokens').insert({
    token,
    task_id:    task.id,
    user_id:    userId,
    expires_at: expiresAt,
  });

  const completionUrl = `https://sahilrathour007.github.io/TWT_Retention_Webpage/alpino_journey.html?t=${token}`;

  const { data: emailLogRow } = await supabase.from('email_log').insert({
    user_id:    userId,
    task_id:    task.id,
    email_type: 'day1_immediate',
    status:     'pending',
    attempt:    1,
  }).select('id').single();

  await resend.emails.send({
    from:    RESEND_FROM_EMAIL,
    to:      userEmail,
    subject: `Day 1 — your habit starts now`,
    html:    buildDailyTaskEmailHTML({
      userName,
      taskDescription: task.description,
      taskType:        task.task_type,
      dayNumber:       1,
      completionUrl,
      streak:          0,
      primaryProduct:  task.primary_product || null,
      dosageLabel:     task.dosage_label    || null,
    }),
  });

  await supabase.from('habit_tasks').update({
    status:        'sent',
    email_sent_at: new Date().toISOString(),
  }).eq('id', task.id);

  await supabase.from('habit_tasks').update({
    scheduled_date: today,
  }).eq('id', task.id);

  await supabase.from('user_state').update({
    email_cooldown_until: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  }).eq('user_id', userId);

  if (emailLogRow) {
    await supabase.from('email_log').update({
      status:  'sent',
      sent_at: new Date().toISOString(),
    }).eq('id', emailLogRow.id);
  }

  await supabase.from('events').insert({
    user_id:    userId,
    event_type: 'email_sent',
    metadata:   { task_id: task.id, day: 1, email_type: 'day1_immediate' },
  });

  console.log(`[SIGNUP] Day 1 task email sent to ${userEmail}`);
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'The Whole Truth API v4.5', ready: serverReady });
});

// ── POST /order ───────────────────────────────────────────────
app.post('/order', async (req, res) => {
  const { orders } = req.body;

  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ success: false, message: 'No orders provided.' });
  }

  const allErrors = [];
  orders.forEach((item, i) => {
    const errs = validateOrderItem(item);
    if (errs.length) allErrors.push(`Item ${i + 1}: ${errs.join(', ')}`);
  });
  if (allErrors.length) {
    return res.status(400).json({ success: false, message: allErrors.join(' | ') });
  }

  const duplicates = orders.filter(item =>
    isDuplicateOrder(item.name, item.phone, item.product_name)
  );
  if (duplicates.length > 0) {
    return res.status(409).json({
      success: false,
      message: 'Duplicate order detected. Please wait before resubmitting.',
    });
  }

  const orderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // ← FIX v4.4: orderId is now a real UUID for Supabase foreign key columns (uuid-typed)
  // displayOrderId is the human-readable TWT-... string used only in emails and API responses
  const orderId        = crypto.randomUUID();          // real UUID → goes to DB
  const displayOrderId = 'TWT-' + Date.now();          // human-readable → emails + response only

  const isReorder = orders[0]?.utm_source === 'email';

  const rows = orders.map(item => ({
    order_date:    orderDate,
    name:          item.name.trim(),
    email:         (item.email || '').trim(),
    phone:         item.phone.trim(),
    city:          item.city.trim(),
    address:       item.address.trim(),
    product_name:  item.product_name.trim(),
    quantity:      item.quantity    || 1,
    order_value:   item.order_value,
    return_status: 'No',
    utm_source:    item.utm_source  || 'organic',
    utm_medium:    item.utm_medium  || '',
    utm_campaign:  item.utm_campaign || '',
  }));

  try {
    if (!GOOGLE_SCRIPT_URL) throw new Error('GOOGLE_SCRIPT_URL not set');
    const sheetsRes = await axios.post(GOOGLE_SCRIPT_URL, { rows }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    if (sheetsRes.data?.status !== 'success') {
      throw new Error('Sheets non-success: ' + JSON.stringify(sheetsRes.data));
    }
  } catch (err) {
    console.error('[SHEETS ERROR]', err.message);
    return res.status(500).json({
      success: false,
      message: 'Order received but sheet logging failed. Contact support.',
    });
  }

  orders.forEach(item => registerOrder(item.name, item.phone, item.product_name));

  const customerEmail = (orders[0]?.email || '').trim();
  if (customerEmail) {
    const total = orders.reduce((s, i) => s + i.order_value, 0);
    const html  = buildConfirmationEmail({
      name: orders[0].name, email: customerEmail,
      phone: orders[0].phone, city: orders[0].city,
      address: orders[0].address, items: rows, total,
      displayOrderId,   // ← human-readable ID shown to customer
      isReorder,
    });

    resend.emails.send({
      from:    RESEND_FROM_EMAIL,
      to:      customerEmail,
      subject: isReorder ? 'Reorder Confirmed! — The Whole Truth' : 'Order Confirmed! — The Whole Truth',
      html,
    }).then(() => console.log(`[EMAIL] Order confirmation sent to ${customerEmail}`))
      .catch(err => console.warn('[EMAIL WARN]', err.message));
  }

  if (customerEmail && SUPABASE_URL) {
    // ← Pass both orderId (UUID for DB) and displayOrderId (text for reference)
    writeOrderToSupabase(orders, rows, orderId, displayOrderId, orderDate).catch(err => {
      console.error('[SUPABASE ORDER ERROR] Message:', err.message);
      console.error('[SUPABASE ORDER ERROR] Details:', err.details);
      console.error('[SUPABASE ORDER ERROR] Hint:', err.hint);
      console.error('[SUPABASE ORDER ERROR] Code:', err.code);
    });
  }

  console.log(`[ORDER] ${rows.length} item(s) | ${rows[0].name} | ${orderDate}`);
  return res.status(200).json({
    success: true, message: 'Order placed successfully!',
    order_id: displayOrderId,   // ← customer-facing response still shows TWT-... format
    order_count: rows.length,
  });
});

// ── writeOrderToSupabase ──────────────────────────────────────
async function writeOrderToSupabase(orders, rows, orderId, displayOrderId, orderDate) {
  const customerEmail = (orders[0]?.email || '').trim();
  if (!customerEmail) return;

  let userId = null;

  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', customerEmail)
    .maybeSingle();

  if (existingUser) {
    userId = existingUser.id;
    await supabase
      .from('users')
      .update({
        city:   orders[0].city || '',
        source: 'website',
      })
      .eq('id', userId)
      .is('city', null);
  } else {
    const { data: newUser, error: insertErr } = await supabase
      .from('users')
      .insert({
        name:   orders[0].name,
        email:  customerEmail,
        phone:  orders[0].phone,
        city:   orders[0].city   || '',
        source: 'website',
      })
      .select('id')
      .single();
    if (insertErr) {
      console.error('[USERS INSERT ERROR]', insertErr.message, insertErr.details, insertErr.hint);
      throw insertErr;
    }
    userId = newUser.id;
  }

  for (const item of rows) {
    const unitPrice = item.quantity > 0
      ? Math.round((item.order_value / item.quantity) * 100) / 100
      : item.order_value;

    const { error: itemErr } = await supabase.from('order_items').insert({
      user_id:      userId,
      order_id:     orderId,          // ← real UUID, matches uuid column type
      product_name: item.product_name,
      category:     deriveCategory(item.product_name),  // ✅ PERMANENT FIX: derived from product_name, never trusted from frontend
      quantity:     item.quantity,
      unit_price:   unitPrice,
      order_value:  item.order_value,
      utm_source:   item.utm_source,
      utm_medium:   item.utm_medium,
      utm_campaign: item.utm_campaign,
      order_date:   orderDate,
    });
    if (itemErr) {
      console.error('[ORDER_ITEMS INSERT ERROR] Message:', itemErr.message);
      console.error('[ORDER_ITEMS INSERT ERROR] Details:', itemErr.details);
      console.error('[ORDER_ITEMS INSERT ERROR] Hint:', itemErr.hint);
      console.error('[ORDER_ITEMS INSERT ERROR] Item:', item.product_name);
      throw new Error('order_items insert failed: ' + itemErr.message);
    }
  }

  const { error: eventErr } = await supabase.from('events').insert({
    user_id:    userId,
    event_type: 'order_placed',
    metadata:   {
      order_id:         orderId,
      display_order_id: displayOrderId,
      items:    rows.map(r => ({ product: r.product_name, qty: r.quantity, value: r.order_value })),
      source:   'website',
    },
  });
  if (eventErr) {
    console.error('[EVENTS INSERT ERROR]', eventErr.message, eventErr.details);
  }

  console.log(`[SUPABASE] order_items + event written for order ${displayOrderId} (${orderId})`);
}

// ── POST /habit/signup ────────────────────────────────────────
app.post('/habit/signup', async (req, res) => {
  const { name, email, phone, goal, lifestyle, diet_pref } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'name and email required' });
  }

  try {
    let userId;
    const { data: existingUser } = await supabase
      .from('users').select('id').eq('email', email).maybeSingle();

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: newUser, error: insertErr } = await supabase
        .from('users').insert({ name, email, phone: phone || '' }).select('id').single();
      if (insertErr) throw new Error(`users insert failed: ${insertErr.message}`);
      userId = newUser.id;
    }

    const { data: existingIntent } = await supabase
      .from('user_intent').select('id').eq('user_id', userId).maybeSingle();

    if (!existingIntent) {
      await supabase.from('user_intent').insert({
        user_id: userId, goal: goal || '', lifestyle: lifestyle || '', diet_pref: diet_pref || '',
      });
    }

    const { data: existingState } = await supabase
      .from('user_state').select('id').eq('user_id', userId).maybeSingle();

    if (!existingState) {
      await supabase.from('user_state').insert({
        user_id: userId, current_streak: 0, longest_streak: 0,
        fatigue_score: 0, segment: 'new',
      });
    }

    const { data: latestOrder } = await supabase
      .from('order_items')
      .select('order_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // ← FIX v4.5: single declaration with UUID validation guard
    // Removed duplicate const resolvedOrderId, restored generateHabitPlan() call
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const resolvedOrderId = latestOrder?.order_id && UUID_REGEX.test(latestOrder.order_id)
      ? latestOrder.order_id
      : null;

    const planResult = await generateHabitPlan(userId, resolvedOrderId);
    if (!planResult?.planId) throw new Error('generateHabitPlan returned no planId');

    await sendDay1TaskEmail(userId, email, name);

    await supabase.from('events').insert({
      user_id: userId, event_type: 'signup',
      metadata: { goal, lifestyle, diet_pref, plan_id: planResult.planId },
    });

    console.log(`[SIGNUP] New user ${email} | plan ${planResult.planId}`);
    return res.status(200).json({ success: true, message: 'Signup complete. Day 1 email sent.' });

  } catch (err) {
    console.error('[SIGNUP ERROR]', err.message);
    return res.status(500).json({ success: false, message: 'Signup failed: ' + err.message });
  }
});

// ── GET /complete ─────────────────────────────────────────────
app.get('/complete', async (req, res) => {
  const t = (req.query.t || '').trim();
  if (!t) return res.status(400).json({ message: 'Token required' });

  const now = new Date();

  const { data: tokenRow, error: tokenErr } = await supabase
    .from('completion_tokens')
    .select('task_id, user_id, used, expires_at')
    .eq('token', t)
    .maybeSingle();

  if (tokenErr || !tokenRow) {
    return res.status(404).json({ message: 'Invalid or expired token' });
  }

  const { task_id, user_id, used } = tokenRow;

  if (used) {
    return res.redirect(`https://sahilrathour007.github.io/TWT_Retention_Webpage/alpino_journey.html?t=${t}`);
  }

  const { data: task } = await supabase
    .from('habit_tasks')
    .select('id, day_number, status')
    .eq('id', task_id)
    .maybeSingle();

  if (!task) return res.status(404).json({ message: 'Task not found' });

  const completionType = new Date(tokenRow.expires_at) < now ? 'late' : 'on_time';

  await supabase.from('completion_tokens').update({ used: true }).eq('token', t);
  await supabase.from('habit_tasks').update({
    status: 'completed', completion_type: completionType, completed_at: now.toISOString(),
  }).eq('id', task_id);

  const today = getISTDate(0);
  const { data: state } = await supabase
    .from('user_state')
    .select('current_streak, longest_streak, last_completed_date, fatigue_score')
    .eq('user_id', user_id)
    .single();

  const yesterday     = getISTDate(-1);
  const isConsecutive = state?.last_completed_date === yesterday;
  const newStreak     = isConsecutive ? (state.current_streak || 0) + 1 : 1;
  const newLongest    = Math.max(newStreak, state?.longest_streak || 0);
  const newFatigue    = Math.max(0, (state?.fatigue_score || 0) - 1);

  await supabase.from('user_state').update({
    current_streak: newStreak, longest_streak: newLongest,
    last_completed_day: task.day_number, last_completed_date: today,
    fatigue_score: newFatigue, last_active_at: now.toISOString(),
  }).eq('user_id', user_id);

  await supabase.from('events').insert({
    user_id, event_type: 'task_clicked',
    metadata: { task_id, completion_type: completionType, day: task.day_number, streak: newStreak },
  });

  if (task.day_number >= 5) {
    const { data: stateCheck } = await supabase
      .from('user_state').select('reorder_triggered').eq('user_id', user_id).single();
    if (!stateCheck?.reorder_triggered) {
      triggerReorderEmail(user_id, task_id).catch(err => console.warn('[REORDER TRIGGER WARN]', err.message));
    }
  }

  res.redirect(`https://sahilrathour007.github.io/TWT_Retention_Webpage/alpino_journey.html?t=${t}`);
});

async function triggerReorderEmail(userId, taskId) {
  const { data: user } = await supabase.from('users').select('email, name').eq('id', userId).single();
  if (!user) return;

  await resend.emails.send({
    from:    RESEND_FROM_EMAIL,
    to:      user.email,
    subject: `Running low? Reorder before you lose momentum`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F6F1E9;font-family:Arial,sans-serif;">
  <div style="max-width:520px;margin:24px auto;background:#FDFAF5;border:1px solid #D8CEBC;border-radius:12px;overflow:hidden;">
    <div style="background:#1a1a1a;padding:16px 28px;">
      <span style="color:#fff;font-size:12px;font-weight:700;letter-spacing:4px;">THE WHOLE TRUTH</span>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 12px;">You have built 5+ days of habit, ${user.name}.</h2>
      <p style="color:#4A4845;line-height:1.7;font-size:15px;">
        Most people quit before this. You did not.<br><br>
        Your supply is likely running low. Reorder now so there is no gap in your habit.
      </p>
      <a href="https://sahilrathour007.github.io/?utm_source=habit_engine&utm_medium=reorder_email&utm_campaign=day5_trigger"
         style="display:block;text-align:center;background:#C47A3A;color:#fff;padding:14px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:20px;">
        Reorder Now
      </a>
    </div>
  </div></body></html>`,
  });

  await supabase.from('user_state').update({
    reorder_triggered: true, reorder_triggered_at: new Date().toISOString(),
  }).eq('user_id', userId);

  await supabase.from('events').insert({
    user_id: userId, event_type: 'reorder_triggered',
    metadata: { task_id: taskId, trigger: 'day5_completion' },
  });
}

// ═══════════════════════════════════════════════════════════════
//  CRON: /cron/daily-tasks
// ═══════════════════════════════════════════════════════════════
app.post('/cron/daily-tasks', cronGuard, async (req, res) => {
  if (!serverReady) {
    console.log('[CRON] daily-tasks rejected — server still warming up');
    return res.status(503).json({ error: 'Server warming up, retry in 15s' });
  }

  const today   = getISTDate(0);
  const runId   = crypto.randomBytes(8).toString('hex');
  console.log(`[CRON] daily-tasks enqueue run ${runId} for ${today}`);

  const { data: tasks, error } = await supabase
    .from('habit_tasks')
    .select(`
      id, user_id, day_number, description, task_type,
      users(name, email)
    `)
    .eq('scheduled_date', today)
    .eq('status', 'pending')
    .not('user_id', 'is', null);

  if (error) {
    console.error(`[CRON] Query failed (run ${runId}):`, error.message);
    await logCronRun({ runId, type: 'daily-tasks', date: today, tasksFound: 0, jobsCreated: 0, errors: error.message });
    return res.status(500).json({ error: error.message });
  }

  const validTasks = (tasks || []).filter(t => t.users?.email);
  console.log(`[CRON] Found ${validTasks.length} valid tasks — enqueueing (run ${runId})`);

  let jobsCreated = 0;
  let jobsSkipped = 0;

  for (const task of validTasks) {
    const { data: existingJob } = await supabase
      .from('job_queue')
      .select('id, status')
      .eq('task_id', task.id)
      .eq('type', 'send_daily_email')
      .in('status', ['pending', 'processing', 'done'])
      .maybeSingle();

    if (existingJob) {
      console.log(`[CRON] Skipping task ${task.id} — job already exists (${existingJob.status})`);
      jobsSkipped++;
      continue;
    }

    const { error: insertErr } = await supabase.from('job_queue').insert({
      type:       'send_daily_email',
      task_id:    task.id,
      user_id:    task.user_id,
      status:     'pending',
      attempts:   0,
      run_id:     runId,
      created_at: new Date().toISOString(),
    });

    if (insertErr) {
      console.error(`[CRON] Failed to enqueue task ${task.id}:`, insertErr.message);
    } else {
      jobsCreated++;
    }
  }

  await logCronRun({
    runId, type: 'daily-tasks', date: today,
    tasksFound: validTasks.length, jobsCreated, errors: null,
  });

  console.log(`[CRON] daily-tasks enqueue done: queued=${jobsCreated} skipped=${jobsSkipped} (run ${runId})`);
  return res.json({ run_id: runId, queued: jobsCreated, skipped: jobsSkipped, total: validTasks.length });
});

// ═══════════════════════════════════════════════════════════════
//  WORKER: /worker/process-jobs
// ═══════════════════════════════════════════════════════════════
app.post('/worker/process-jobs', workerGuard, async (req, res) => {
  if (!serverReady) {
    return res.status(503).json({ error: 'Server warming up' });
  }

  const workerRunId = crypto.randomBytes(8).toString('hex');
  console.log(`[WORKER] Starting run ${workerRunId}`);

  const now = new Date().toISOString();

  const { data: jobs, error: fetchErr } = await supabase
    .from('job_queue')
    .select('id, type, task_id, user_id, attempts, run_id')
    .eq('status', 'pending')
    .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
    .order('created_at', { ascending: true })
    .limit(5);

  if (fetchErr) {
    console.error(`[WORKER] Failed to fetch jobs (run ${workerRunId}):`, fetchErr.message);
    return res.status(500).json({ error: fetchErr.message });
  }

  if (!jobs || jobs.length === 0) {
    console.log(`[WORKER] No pending jobs (run ${workerRunId})`);
    return res.json({ processed: 0, failed: 0 });
  }

  const jobIds = jobs.map(j => j.id);
  const { error: claimErr } = await supabase
    .from('job_queue')
    .update({ status: 'processing', claimed_at: now })
    .in('id', jobIds)
    .eq('status', 'pending');

  if (claimErr) {
    console.error(`[WORKER] Claim failed (run ${workerRunId}):`, claimErr.message);
    return res.status(500).json({ error: claimErr.message });
  }

  let processed = 0;
  let failed    = 0;

  for (const job of jobs) {
    try {
      if (job.type === 'send_daily_email') {
        await processEmailJob(job, workerRunId);
        processed++;
      } else {
        console.warn(`[WORKER] Unknown job type: ${job.type}`);
        await supabase.from('job_queue').update({
          status: 'failed', last_error: `Unknown job type: ${job.type}`,
        }).eq('id', job.id);
        failed++;
      }
    } catch (err) {
      console.error(`[WORKER] Job ${job.id} failed (attempt ${job.attempts + 1}):`, err.message);
      const newAttempts = (job.attempts || 0) + 1;

      if (newAttempts >= 3) {
        await supabase.from('job_queue').update({
          status: 'failed', attempts: newAttempts, last_error: err.message,
        }).eq('id', job.id);

        await supabase.from('dead_letters').insert({
          job_type:      job.type,
          payload:       { user_id: job.user_id, task_id: job.task_id },
          error_msg:     err.message,
          retry_count:   newAttempts,
          next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });

        console.error(`[WORKER] Job ${job.id} dead-lettered after ${newAttempts} attempts`);
      } else {
        const backoffMs    = newAttempts === 1 ? 5 * 60_000 : 15 * 60_000;
        const nextRetryAt  = new Date(Date.now() + backoffMs).toISOString();
        await supabase.from('job_queue').update({
          status:        'pending',
          attempts:      newAttempts,
          last_error:    err.message,
          next_retry_at: nextRetryAt,
        }).eq('id', job.id);

        console.log(`[WORKER] Job ${job.id} requeued — retry ${newAttempts}/3 at ${nextRetryAt}`);
      }

      failed++;
    }
  }

  console.log(`[WORKER] Run ${workerRunId} done: processed=${processed} failed=${failed}`);
  return res.json({ worker_run_id: workerRunId, processed, failed, total: jobs.length });
});

// ── Process a single email job ────────────────────────────────
async function processEmailJob(job, workerRunId) {
  const { task_id, user_id } = job;

  const { data: task, error: taskErr } = await supabase
    .from('habit_tasks')
    .select('id, day_number, description, task_type, status, scheduled_date')
    .eq('id', task_id)
    .single();

  if (taskErr || !task) {
    throw new Error(`Task ${task_id} not found: ${taskErr?.message}`);
  }

  if (task.status === 'sent' || task.status === 'completed') {
    console.log(`[WORKER] Task ${task_id} already ${task.status} — marking job done`);
    await supabase.from('job_queue').update({ status: 'done' }).eq('id', job.id);
    return;
  }

  const { data: user, error: userErr } = await supabase
    .from('users').select('id, name, email').eq('id', user_id).single();

  if (userErr || !user?.email) {
    throw new Error(`User ${user_id} not found or no email: ${userErr?.message}`);
  }

  const { data: userState } = await supabase
    .from('user_state')
    .select('current_streak, fatigue_score, email_cooldown_until')
    .eq('user_id', user_id)
    .maybeSingle();

  const cooldown = userState?.email_cooldown_until;
  if (cooldown && new Date(cooldown) > new Date()) {
    console.log(`[WORKER] User ${user_id} on cooldown until ${cooldown} — skipping`);
    await supabase.from('job_queue').update({ status: 'done', last_error: 'skipped: cooldown' }).eq('id', job.id);
    return;
  }

  try {
    await adaptTodayTask(user_id);
  } catch (adaptErr) {
    console.error(`[WORKER] adaptTodayTask failed for user ${user_id}:`, adaptErr.message);
  }

  const { data: freshTask } = await supabase
    .from('habit_tasks')
    .select('description, task_type, primary_product, dosage_label')
    .eq('id', task_id)
    .single();

  const description      = freshTask?.description      || task.description;
  const taskType         = freshTask?.task_type         || task.task_type;
  const primaryProduct   = freshTask?.primary_product   || null;
  const dosageLabel      = freshTask?.dosage_label      || null;
  const streak           = userState?.current_streak    || 0;

  const token      = crypto.randomBytes(32).toString('hex');
  const expiresAt  = new Date(Date.now() + 24 * 3_600_000).toISOString();

  const { error: tokenErr } = await supabase.from('completion_tokens').insert({
    token, task_id, user_id, expires_at: expiresAt,
  });
  if (tokenErr) throw new Error(`Token insert failed: ${tokenErr.message}`);

  const completionUrl = `https://sahilrathour007.github.io/TWT_Retention_Webpage/alpino_journey.html?t=${token}`;

  const { data: emailLogRow } = await supabase.from('email_log').insert({
    user_id, task_id,
    email_type: 'daily_task',
    status:     'pending',
    attempt:    (job.attempts || 0) + 1,
  }).select('id').single();

  await resend.emails.send({
    from:    RESEND_FROM_EMAIL,
    to:      user.email,
    subject: `Day ${task.day_number} — your habit is waiting`,
    html:    buildDailyTaskEmailHTML({
      userName:        user.name,
      taskDescription: description,
      taskType,
      dayNumber:       task.day_number,
      completionUrl,
      streak,
      primaryProduct,
      dosageLabel,
    }),
  });

  const sentAt = new Date().toISOString();

  await supabase.from('habit_tasks').update({
    status: 'sent', email_sent_at: sentAt,
  }).eq('id', task_id);

  if (emailLogRow) {
    await supabase.from('email_log').update({
      status: 'sent', sent_at: sentAt,
    }).eq('id', emailLogRow.id);
  }

  await supabase.from('user_state').update({
    email_cooldown_until: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  }).eq('user_id', user_id);

  await supabase.from('events').insert({
    user_id, event_type: 'email_sent',
    metadata: { task_id, day: task.day_number, email_type: 'daily_task', worker_run: workerRunId },
  });

  await supabase.from('job_queue').update({
    status: 'done', completed_at: sentAt,
  }).eq('id', job.id);

  console.log(`[WORKER] Email sent to ${user.email} for Day ${task.day_number} (job ${job.id})`);
}

// ── CRON: /cron/recovery-check ────────────────────────────────
app.post('/cron/recovery-check', cronGuard, async (req, res) => {
  if (!serverReady) {
    console.log('[CRON] recovery-check rejected — server still warming up');
    return res.status(503).json({ error: 'Server warming up, retry in 15s' });
  }

  const yesterday = getISTDate(-1);
  console.log(`[CRON] recovery-check for ${yesterday}`);

  const { data: missedTasks, error: missedErr } = await supabase
    .from('habit_tasks')
    .select(`
      id, user_id, day_number,
      users(name, email)
    `)
    .eq('scheduled_date', yesterday)
    .eq('status', 'sent');

  if (missedErr) {
    console.error('[CRON] recovery-check query failed:', missedErr.message);
    return res.status(500).json({ error: missedErr.message });
  }

  const validMissed = (missedTasks || []).filter(t => t.users?.email);
  if (!validMissed.length) return res.json({ processed: 0 });

  let processed = 0;
  for (const task of validMissed) {
    const { data: userState } = await supabase
      .from('user_state')
      .select('fatigue_score, current_streak, email_cooldown_until')
      .eq('user_id', task.user_id)
      .maybeSingle();

    await supabase.from('habit_tasks').update({
      status: 'missed', completion_type: 'missed',
    }).eq('id', task.id);

    const currentFatigue = userState?.fatigue_score || 0;
    const newFatigue     = currentFatigue + 1;
    const newStreak      = newFatigue >= 2 ? 0 : (userState?.current_streak || 0);

    await supabase.from('user_state').update({
      fatigue_score: newFatigue, current_streak: newStreak,
    }).eq('user_id', task.user_id);

    await supabase.from('events').insert({
      user_id: task.user_id, event_type: 'task_missed',
      metadata: { task_id: task.id, day: task.day_number, fatigue_after: newFatigue },
    });

    if (newFatigue >= 2 && task.users?.email) {
      const cooldown = userState?.email_cooldown_until;
      if (!cooldown || new Date(cooldown) <= new Date()) {
        try {
          await resend.emails.send({
            from:    RESEND_FROM_EMAIL,
            to:      task.users.email,
            subject: `No pressure — let us restart your habit`,
            html:    buildRecoveryEmailHTML({ userName: task.users.name, dayNumber: task.day_number }),
          });

          await supabase.from('user_state').update({
            fatigue_score: 0,
            email_cooldown_until: new Date(Date.now() + 6 * 3_600_000).toISOString(),
          }).eq('user_id', task.user_id);

          await supabase.from('events').insert({
            user_id: task.user_id, event_type: 'recovery_sent',
            metadata: { task_id: task.id },
          });
        } catch (err) {
          console.error('[RECOVERY EMAIL ERROR]', task.user_id, err.message);
        }
      }
    }
    processed++;
  }

  retryDeadLetters(3).catch(err => console.error('[DEAD LETTER RETRY ERROR]', err.message));

  console.log(`[CRON] recovery-check done: processed=${processed}`);
  return res.json({ processed });
});

// ── CRON: /cron/segment-update ────────────────────────────────
app.post('/cron/segment-update', cronGuard, async (req, res) => {
  if (!serverReady) {
    console.log('[CRON] segment-update rejected — server still warming up');
    return res.status(503).json({ error: 'Server warming up, retry in 15s' });
  }

  console.log('[CRON] segment-update running');

  const { data: allStates } = await supabase
    .from('user_state')
    .select('user_id, current_streak, fatigue_score, last_active_at, segment');

  if (!allStates?.length) return res.json({ updated: 0 });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  let updated = 0;

  for (const state of allStates) {
    let newSegment;
    if (!state.last_active_at || state.last_active_at < sevenDaysAgo) {
      newSegment = 'drop_off';
    } else if (state.current_streak > 4 && state.fatigue_score < 2) {
      newSegment = 'high_performer';
    } else if (state.fatigue_score >= 2) {
      newSegment = 'inconsistent';
    } else {
      newSegment = 'new';
    }

    if (newSegment !== state.segment) {
      await supabase.from('user_state').update({
        segment: newSegment, segment_updated_at: new Date().toISOString(),
      }).eq('user_id', state.user_id);

      await supabase.from('events').insert({
        user_id: state.user_id, event_type: 'segment_changed',
        metadata: { from: state.segment, to: newSegment },
      });
      updated++;
    }
  }

  console.log(`[CRON] segment-update done: updated=${updated}`);
  return res.json({ updated, total: allStates.length });
});

// ── POST /track-click ─────────────────────────────────────────
app.post('/track-click', async (req, res) => {
  const { phone, email, product, name } = req.body;
  if (!phone && !email) {
    return res.status(400).json({ success: false, message: 'phone or email required' });
  }
  if (TRACKER_GAS_URL) {
    const url = TRACKER_GAS_URL
      + '?mode=pixel'
      + '&phone='   + encodeURIComponent(phone   || '')
      + '&email='   + encodeURIComponent(email   || '')
      + '&product=' + encodeURIComponent(product || '')
      + '&name='    + encodeURIComponent(name    || '');
    axios.get(url, { timeout: 6000 })
      .then(() => console.log('[CLICK] logged:', phone || email, '|', product))
      .catch(err => console.warn('[CLICK WARN]', err.message));
  }
  return res.status(200).json({ success: true });
});

// ── GET /validate-token ───────────────────────────────────────
app.get('/validate-token', async (req, res) => {
  const token = (req.query.t || '').trim();
  if (!token) return res.status(400).json({ message: 'Token required' });

  const now = new Date();

  const { data: tokenRow } = await supabase
    .from('completion_tokens')
    .select('task_id, user_id, used, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (!tokenRow) return res.status(404).json({ message: 'Invalid token' });

  const expired  = new Date(tokenRow.expires_at) < now;
  const { task_id, user_id } = tokenRow;

  const [userRes, intentRes, userStateRes, tasksRes, todayTaskRes] = await Promise.all([
    supabase.from('users').select('id, name, email').eq('id', user_id).maybeSingle(),
    supabase.from('user_intent').select('goal, lifestyle, diet_pref').eq('user_id', user_id).maybeSingle(),
    supabase.from('user_state').select('current_streak, longest_streak, last_completed_day, last_completed_date, fatigue_score, active_plan_id').eq('user_id', user_id).maybeSingle(),
    supabase.from('habit_tasks').select('id, plan_id, day_number, task_type, scheduled_date, status, description, dosage, completion_type, completed_at').eq('user_id', user_id).order('day_number', { ascending: true }),
    supabase.from('habit_tasks').select('id, plan_id, day_number, task_type, scheduled_date, status, description, dosage, completion_type, completed_at').eq('id', task_id).maybeSingle(),
  ]);

  return res.json({
    used:      tokenRow.used,
    expired,
    user:      userRes.data      || null,
    intent:    intentRes.data    || null,
    userState: userStateRes.data || null,
    tasks:     tasksRes.data     || [],
    todayTask: todayTaskRes.data || null,
  });
});

// ── HELPER: Log cron runs ─────────────────────────────────────
async function logCronRun({ runId, type, date, tasksFound, jobsCreated, errors }) {
  try {
    await supabase.from('cron_runs').insert({
      run_id:       runId,
      cron_type:    type,
      run_date:     date,
      tasks_found:  tasksFound,
      jobs_created: jobsCreated,
      errors:       errors,
      ran_at:       new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[CRON LOG WARN] Failed to write cron_runs:', err.message);
  }
}

// ── POST /complete-task ───────────────────────────────────────
app.post('/complete-task', async (req, res) => {
  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ message: 'Token required' });

  const now = new Date();

  const { data: tokenRow, error: tokenErr } = await supabase
    .from('completion_tokens')
    .select('task_id, user_id, used, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (tokenErr || !tokenRow) {
    return res.status(404).json({ message: 'Invalid or expired token' });
  }

  const { task_id, user_id, used } = tokenRow;

  if (used) {
    return res.status(410).json({ message: 'Token already used', already_done: true });
  }

  const { data: task } = await supabase
    .from('habit_tasks')
    .select('id, day_number, status')
    .eq('id', task_id)
    .maybeSingle();

  if (!task) return res.status(404).json({ message: 'Task not found' });

  const completionType = new Date(tokenRow.expires_at) < now ? 'late' : 'on_time';

  await supabase.from('completion_tokens').update({ used: true }).eq('token', token);
  await supabase.from('habit_tasks').update({
    status: 'completed', completion_type: completionType, completed_at: now.toISOString(),
  }).eq('id', task_id);

  const today     = getISTDate(0);
  const yesterday = getISTDate(-1);

  const { data: state } = await supabase
    .from('user_state')
    .select('current_streak, longest_streak, last_completed_date, fatigue_score')
    .eq('user_id', user_id)
    .single();

  const isConsecutive = state?.last_completed_date === yesterday;
  const newStreak     = isConsecutive ? (state.current_streak || 0) + 1 : 1;
  const newLongest    = Math.max(newStreak, state?.longest_streak || 0);
  const newFatigue    = Math.max(0, (state?.fatigue_score || 0) - 1);

  await supabase.from('user_state').update({
    current_streak: newStreak, longest_streak: newLongest,
    last_completed_day: task.day_number, last_completed_date: today,
    fatigue_score: newFatigue, last_active_at: now.toISOString(),
  }).eq('user_id', user_id);

  await supabase.from('events').insert({
    user_id, event_type: 'task_clicked',
    metadata: { task_id, completion_type: completionType, day: task.day_number, streak: newStreak },
  });

  if (task.day_number >= 5) {
    const { data: stateCheck } = await supabase
      .from('user_state').select('reorder_triggered').eq('user_id', user_id).single();
    if (!stateCheck?.reorder_triggered) {
      triggerReorderEmail(user_id, task_id).catch(err => console.warn('[REORDER TRIGGER WARN]', err.message));
    }
  }

  return res.status(200).json({ success: true, new_streak: newStreak, day: task.day_number });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found.' });
});

app.listen(PORT, () => {
  console.log(`\n The Whole Truth API v4.6 on port ${PORT}`);
  console.log(`   Gmail:     ${process.env.GMAIL_USER      ? 'set: ' + process.env.GMAIL_USER : 'not set'}`);
  console.log(`   Sheets:    ${GOOGLE_SCRIPT_URL            ? 'set' : 'not set'}`);
  console.log(`   Supabase:  ${SUPABASE_URL                 ? 'set' : 'not set'}`);
  console.log(`   Resend:    ${RESEND_API_KEY               ? 'set' : 'not set'}`);
  console.log(`   Cron:      ${CRON_SECRET                  ? 'set' : 'not set'}\n`);
});
