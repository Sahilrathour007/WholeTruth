// ============================================================
// habitEngine.js — The Brain v2.5
//
// What changed from v2.4:
//
//   v2.5 — PRODUCT MISMATCH GUARD: fully diet-aware
//     • Previously the guard only allowed peanut_butter as a valid
//       vegan substitute for whey. This was incomplete:
//       – muesli is also blocked for vegan (dairy) → peanut_butter valid
//       – protein_bar is also blocked for vegan → peanut_butter valid
//       – muesli_vegan is an adaptation, not a rejection → muesli valid
//     • Guard now reads PRODUCT_DIET_RULES from taskTemplates to resolve
//       what the final product WILL be after diet substitution, then
//       checks THAT against the mismatch list. No more false aborts.
//
//   v2.5 — buildUserContext: scoped to most recent order when no orderId given
//     • Previously: pulled ALL order_items for the user (polluted by history)
//     • Now: resolves the most recent order_id and scopes to it
//     • If no orders exist, items = [] (no phantom fallback to peanut_butter)
//
//   v2.5 — diet_pref added to diagnostic log
//
//   v2.4 (kept):
//     - acquireLock: purge expired locks before insert
//     - generateHabitPlan: catch writeToDb errors → dead_letters
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { getTemplate, getTaskForDay, isProductAllowedForDiet, PRODUCT_DIET_RULES } = require('./taskTemplates');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────────
// TIMEZONE — IST via Intl API (no manual +330)
// ─────────────────────────────────────────────
function getISTDate(daysOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;

  return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────
// STEP 0 — RATE / CONCURRENCY CONTROL
// ─────────────────────────────────────────────
async function acquireLock(userId) {
  const lockKey   = `lock:plan:${userId}`;
  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30_000).toISOString();

  // PERMANENT FIX: delete any stale/expired locks first.
  await supabase
    .from('distributed_locks')
    .delete()
    .eq('lock_key', lockKey)
    .lt('expires_at', now);

  const { data, error } = await supabase
    .from('distributed_locks')
    .insert({ lock_key: lockKey, expires_at: expiresAt })
    .select('id')
    .single();

  if (error) return { acquired: false };
  return { acquired: true, lockId: data.id };
}

async function releaseLock(lockId) {
  if (!lockId) return;
  await supabase.from('distributed_locks').delete().eq('id', lockId);
}

// ─────────────────────────────────────────────
// STEP 1 — IDEMPOTENCY CHECK
// ─────────────────────────────────────────────
async function checkIdempotency(userId, orderId) {
  const key = `plan:${userId}:${orderId || 'alpino'}`;

  const { data } = await supabase
    .from('habit_plans')
    .select('id, plan_type, status')
    .eq('idempotency_key', key)
    .maybeSingle();

  return data ? { exists: true, planId: data.id } : { exists: false };
}

// ─────────────────────────────────────────────
// STEP 2 — BUILD USER CONTEXT
// ─────────────────────────────────────────────
async function buildUserContext(userId, orderId) {
  // v2.5 FIX: When orderId is absent, scope to the MOST RECENT order only.
  // Using all user history caused old purchases to skew product selection
  // (e.g. an old peanut_butter order outweighing a fresh whey+muesli order).
  let resolvedOrderId = orderId;
  if (!resolvedOrderId) {
    const { data: latestItem } = await supabase
      .from('order_items')
      .select('order_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    resolvedOrderId = latestItem?.order_id || null;
  }

  const itemsQuery = resolvedOrderId
    ? supabase.from('order_items').select('product_name, category, quantity').eq('order_id', resolvedOrderId)
    : supabase.from('order_items').select('product_name, category, quantity').eq('user_id', userId).limit(0);

  const [userRes, intentRes, stateRes, itemsRes] = await Promise.all([
    supabase.from('users').select('id, name, email, city').eq('id', userId).single(),
    supabase.from('user_intent').select('goal, lifestyle, diet_pref, intent_score').eq('user_id', userId).maybeSingle(),
    supabase.from('user_state').select('current_streak, fatigue_score, difficulty_level, active_plan_id, completed_task_count, last_completed_date').eq('user_id', userId).maybeSingle(),
    itemsQuery,
  ]);

  if (userRes.error || !userRes.data) throw new Error(`User not found: ${userId}`);

  const intent = intentRes.data;
  const state  = stateRes.data;

  const missingIntentFields = [];
  if (!intent) {
    missingIntentFields.push('goal', 'lifestyle', 'diet_pref');
  } else {
    if (!intent.goal)      missingIntentFields.push('goal');
    if (!intent.lifestyle) missingIntentFields.push('lifestyle');
    if (!intent.diet_pref) missingIntentFields.push('diet_pref');
  }

  const products       = itemsRes.data || [];
  const sortedProducts = [...products].sort((a, b) => b.quantity - a.quantity);
  const productCategories = [...new Set(sortedProducts.map(p => p.category).filter(Boolean))];
  const productQuantities = {};
  for (const p of sortedProducts) {
    if (p.category) {
      productQuantities[p.category] = (productQuantities[p.category] || 0) + (p.quantity || 0);
    }
  }

  // Diagnostic log — blank category = server.js did not call deriveCategory()
  const blankCategoryProducts = products.filter(p => !p.category);
  if (blankCategoryProducts.length > 0) {
    console.error(
      `[habitEngine] CONTEXT WARNING: ${blankCategoryProducts.length} product(s) have blank category for user ${userId}:`,
      blankCategoryProducts.map(p => p.product_name).join(', ')
    );
    console.error(`[habitEngine] These products are excluded from plan selection. Fix deriveCategory() in server.js.`);
  }

  const dietPref = intent?.diet_pref || 'veg';
  console.log(
    `[habitEngine] buildUserContext: ` +
    `products=[${products.map(p => p.product_name).join(',')}] ` +
    `categories=[${productCategories.join(',')}] ` +
    `quantities=${JSON.stringify(productQuantities)} ` +
    `diet=${dietPref} ` +
    `scopedOrderId=${resolvedOrderId || 'none'}`
  );

  const yesterday      = getISTDate(-1);
  const skippedYesterday = state?.last_completed_date
    ? state.last_completed_date < yesterday
    : false;

  return {
    user:    userRes.data,
    intent:  intent || null,
    state:   state  || { current_streak: 0, fatigue_score: 0, difficulty_level: 'normal', active_plan_id: null, completed_task_count: 0 },
    products: sortedProducts,
    productCategories,
    productQuantities,
    hasIntent: !!intent && missingIntentFields.length === 0,
    missingIntentFields,
    hasOrder: products.length > 0,
    userBehavior: {
      skippedYesterday,
      fatigueScore:   state?.fatigue_score        || 0,
      currentStreak:  state?.current_streak       || 0,
      completedCount: state?.completed_task_count || 0,
    },
  };
}

// ─────────────────────────────────────────────
// STEP 3 — PLAN TYPE DECISION ENGINE
// ─────────────────────────────────────────────
function decidePlanType(context) {
  const { intent, userBehavior } = context;
  const fatigue   = userBehavior.fatigueScore;
  const streak    = userBehavior.currentStreak;
  const lifestyle = intent?.lifestyle || 'sedentary';

  if (fatigue > 2)                           return 'recovery';
  if (streak > 5 && lifestyle === 'athlete') return 'aggressive';
  if (streak === 0)                          return 'beginner';
  return 'normal';
}

// ─────────────────────────────────────────────
// STEP 4 — ARCHIVE EXISTING ACTIVE PLAN
// ─────────────────────────────────────────────
async function archiveActivePlan(userId, existingActivePlanId) {
  if (!existingActivePlanId) return;

  await supabase
    .from('habit_plans')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('id', existingActivePlanId)
    .eq('user_id', userId);

  console.log(`[habitEngine] Archived plan ${existingActivePlanId} for user ${userId}`);
}

// ─────────────────────────────────────────────
// STEP 5 — GENERATE TASK ROWS
// ─────────────────────────────────────────────
function generateTaskRows(planId, userId, context, planType) {
  const { intent, productCategories, productQuantities, userBehavior } = context;

  const safeIntent = {
    goal:      intent?.goal      || 'general_health',
    lifestyle: intent?.lifestyle || 'sedentary',
    diet_pref: intent?.diet_pref || 'veg',
  };

  const templateDays = getTemplate({
    ...safeIntent,
    plan_type: planType,
    productCategories,
    productQuantities,
  });

  return templateDays.map((day) => ({
    plan_id:         planId,
    user_id:         userId,
    day_number:      day.day_number,
    scheduled_date:  getISTDate(day.day_number - 1),
    task_type:       day.task_type,
    dosage:          day.dosage,
    dosage_label:    day.dosage_label    || null,
    primary_product: day.primary_product || null,
    description:     day.description,
    nutrient_focus:  day.nutrient_focus,
    status:          'pending',
  }));
}

// ─────────────────────────────────────────────
// STEP 6 — ATOMIC WRITE
// ─────────────────────────────────────────────
async function writeToDb({ userId, orderId, context, planType, idempotencyKey }) {
  // 6a. Archive any existing active plan
  if (context.state.active_plan_id) {
    await archiveActivePlan(userId, context.state.active_plan_id);
  }

  // 6b. Create plan
  const { data: plan, error: planErr } = await supabase
    .from('habit_plans')
    .insert({
      user_id:         userId,
      order_id:        null,             // PERMANENT FIX: orderId is from order_items, not orders table FK
      plan_type:       planType,
      start_date:      getISTDate(0),
      status:          'active',
      trigger:         orderId ? 'order'   : 'signup',   // matches habit_plans_trigger_check
      source:          orderId ? 'website' : 'alpino',   // matches habit_plans_source_check
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .single();

  if (planErr) {
    console.error(`[habitEngine] habit_plans insert failed for user ${userId}:`, planErr.message);
    throw new Error(`habit_plans insert failed: ${planErr.message}`);
  }

  const planId = plan.id;

  // 6c. Generate task rows
  const taskRows = generateTaskRows(planId, userId, context, planType);

  // ─────────────────────────────────────────────
  // PRODUCT MISMATCH GUARD — v2.5: fully diet-aware
  //
  // Catches bugs where the plan assigns a product the user never ordered.
  // Does NOT fire on expected diet substitutions (those are valid).
  //
  // Logic:
  //   1. orderedProductKeys  = canonical keys of what user bought
  //   2. validOutcomes       = orderedProductKeys + their expected diet substitutes
  //      – 'replace' swap (e.g. whey → peanut_butter for vegan): add replacement
  //      – 'adapt' swap (e.g. muesli → muesli_vegan): primary_product stays 'muesli'
  //   3. If day1Task.primary_product ∉ validOutcomes → real bug → abort
  //
  // Example: vegan + whey + muesli
  //   orderedProductKeys = {whey, muesli}
  //   whey → replace → peanut_butter added to validOutcomes
  //   muesli → adapt → muesli stays in validOutcomes
  //   validOutcomes = {whey, muesli, peanut_butter}
  //   If plan says 'protein_bar' → abort (real bug)
  //   If plan says 'peanut_butter' → ok (expected vegan swap for whey)
  //   If plan says 'muesli' → ok (expected vegan muesli adaptation)
  // ─────────────────────────────────────────────
  if (context.hasOrder && context.productCategories.length > 0) {
    const CATEGORY_MAP = {
      whey:          'whey',
      peanut_butter: 'peanut_butter',
      protein_bar:   'protein_bar',
      muesli:        'muesli',
      protein:       'whey',
      snack:         'protein_bar',
    };

    const dietPref = context.intent?.diet_pref || 'veg';

    const orderedProductKeys = new Set(
      context.productCategories.map(cat => CATEGORY_MAP[cat]).filter(Boolean)
    );

    const validOutcomes = new Set(orderedProductKeys);

    for (const productKey of orderedProductKeys) {
      const rule = PRODUCT_DIET_RULES[productKey];
      if (!rule) continue;
      if (rule.allowed_diets.includes(dietPref)) continue;  // not blocked — no swap needed

      const swap = rule.diet_swap?.[dietPref];
      if (!swap) continue;

      if (swap.action === 'replace') {
        validOutcomes.add(swap.with);  // e.g. peanut_butter
      }
      // 'adapt' keeps the same product key (muesli → muesli) — already in validOutcomes
    }

    const day1Task = taskRows.find(t => t.day_number === 1);
    if (day1Task && day1Task.primary_product && !validOutcomes.has(day1Task.primary_product)) {
      console.error(
        `[habitEngine] PRODUCT MISMATCH: ordered=[${[...orderedProductKeys].join(',')}]` +
        ` validOutcomes=[${[...validOutcomes].join(',')}]` +
        ` plan assigned primary_product="${day1Task.primary_product}"` +
        ` diet="${dietPref}". Aborting plan.`
      );
      await supabase.from('habit_plans').delete().eq('id', planId);
      throw new Error(
        `Product mismatch: ordered [${[...orderedProductKeys].join(',')}] but plan uses ${day1Task.primary_product}.` +
        ` Check deriveCategory() in server.js and CATEGORY_TO_PRODUCT_KEY in taskTemplates.js.`
      );
    }
  }

  // 6d. Insert all tasks
  const { error: tasksErr } = await supabase.from('habit_tasks').insert(taskRows);

  if (tasksErr) {
    await supabase.from('habit_plans').delete().eq('id', planId);

    await supabase.from('dead_letters').insert({
      job_type:      'generate_plan',
      payload:       { userId, orderId, planId, planType, reason: 'task_insert_failed' },
      error_msg:     tasksErr.message,
      retry_count:   0,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });

    throw new Error(`habit_tasks insert failed. Plan ${planId} compensated (deleted). Logged to dead_letters.`);
  }

  // 6e. Update user_state
  await supabase.from('user_state').upsert({
    user_id:          userId,
    active_plan_id:   planId,
    plan_start_date:  getISTDate(0),
    difficulty_level: planType,
    ...(planType === 'recovery' ? { fatigue_score: 0 } : {}),
  });

  // 6f. Log event (non-critical)
  try {
    await supabase.from('events').insert({
      user_id:    userId,
      event_type: 'plan_generated',
      metadata: {
        plan_id:               planId,
        plan_type:             planType,
        order_id:              orderId || null,
        products:              context.products.map(p => p.product_name),
        product_categories:    context.productCategories,
        goal:                  context.intent?.goal,
        lifestyle:             context.intent?.lifestyle,
        diet_pref:             context.intent?.diet_pref,
        streak_at_generation:  context.userBehavior.currentStreak,
        fatigue_at_generation: context.userBehavior.fatigueScore,
      },
    });
  } catch (eventErr) {
    console.warn(`[habitEngine] Event log failed (non-critical): ${eventErr.message}`);
  }

  return planId;
}

// ─────────────────────────────────────────────
// PLAN ADAPTATION — called daily by cron
// ─────────────────────────────────────────────
async function adaptTodayTask(userId) {
  if (!userId) throw new Error('userId is required');

  const context = await buildUserContext(userId, null);
  const { state, intent, productCategories, productQuantities, userBehavior } = context;

  if (!state.active_plan_id) {
    console.warn(`[habitEngine] No active plan to adapt for user ${userId}`);
    return null;
  }

  const today = getISTDate(0);
  const { data: todayTask, error } = await supabase
    .from('habit_tasks')
    .select('id, day_number, task_type, status')
    .eq('plan_id', state.active_plan_id)
    .eq('scheduled_date', today)
    .maybeSingle();

  if (error || !todayTask || todayTask.status !== 'pending') return null;

  const planType = decidePlanType(context);
  const updatedTask = getTaskForDay({
    goal:              intent?.goal      || 'general_health',
    lifestyle:         intent?.lifestyle || 'sedentary',
    diet_pref:         intent?.diet_pref || 'veg',
    plan_type:         planType,
    productCategories,
    productQuantities,
    absoluteDayNumber: todayTask.day_number,
    userBehavior,
  });

  if (updatedTask.task_type === todayTask.task_type) return todayTask;

  const { error: updateErr } = await supabase
    .from('habit_tasks')
    .update({
      task_type:   updatedTask.task_type,
      dosage:      updatedTask.dosage,
      description: updatedTask.description,
      adapted_at:  new Date().toISOString(),
    })
    .eq('id', todayTask.id);

  if (updateErr) {
    console.error(`[habitEngine] Task adaptation failed for task ${todayTask.id}: ${updateErr.message}`);
    return null;
  }

  console.log(`[habitEngine] Task ${todayTask.id} adapted: ${todayTask.task_type} → ${updatedTask.task_type}`);
  return updatedTask;
}

// ─────────────────────────────────────────────
// DEAD LETTER RETRY PROCESSOR
// ─────────────────────────────────────────────
async function retryDeadLetters(maxRetries = 3) {
  const now = new Date().toISOString();

  const { data: jobs } = await supabase
    .from('dead_letters')
    .select('*')
    .eq('job_type', 'generate_plan')
    .lt('retry_count', maxRetries)
    .lte('next_retry_at', now)
    .limit(10);

  if (!jobs || jobs.length === 0) return;

  for (const job of jobs) {
    const { userId, orderId } = job.payload;

    try {
      await generateHabitPlan(userId, orderId);
      await supabase.from('dead_letters').delete().eq('id', job.id);
      console.log(`[habitEngine] Dead letter ${job.id} retried successfully`);
    } catch (err) {
      const backoffMs = Math.pow(2, job.retry_count) * 60_000;
      await supabase.from('dead_letters').update({
        retry_count:   job.retry_count + 1,
        error_msg:     err.message,
        next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
      }).eq('id', job.id);

      console.error(`[habitEngine] Dead letter ${job.id} retry ${job.retry_count + 1} failed: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────
// MAIN EXPORT: generateHabitPlan()
// ─────────────────────────────────────────────
async function generateHabitPlan(userId, orderId = null) {
  if (!userId) throw new Error('userId is required');

  const idempotencyKey = `plan:${userId}:${orderId || 'alpino'}`;

  const { exists, planId: existingPlanId } = await checkIdempotency(userId, orderId);
  if (exists) {
    console.log(`[habitEngine] Plan already exists for key ${idempotencyKey}. Skipping.`);
    return { planId: existingPlanId, skipped: true };
  }

  const { acquired, lockId } = await acquireLock(userId);
  if (!acquired) {
    throw new Error(`[habitEngine] Plan generation already in progress for user ${userId}. Try again shortly.`);
  }

  let context;
  try {
    context = await buildUserContext(userId, orderId);
  } catch (err) {
    await releaseLock(lockId);
    await supabase.from('dead_letters').insert({
      job_type:      'generate_plan',
      payload:       { userId, orderId, reason: 'context_build_failed' },
      error_msg:     err.message,
      retry_count:   0,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
    throw err;
  }

  if (!context.hasIntent) {
    console.warn(`[habitEngine] Missing intent fields for ${userId}: [${context.missingIntentFields.join(', ')}]. Plan will use safe defaults.`);
  }

  try {
    const planType = decidePlanType(context);

    const planId = await writeToDb({
      userId,
      orderId,
      context,
      planType,
      idempotencyKey,
    });

    console.log(`[habitEngine] Plan ${planId} (${planType}) generated for user ${userId}`);
    return { planId, skipped: false, planType };
  } catch (err) {
    console.error(`[habitEngine] writeToDb failed for user ${userId}: ${err.message}`);
    await supabase.from('dead_letters').insert({
      job_type:      'generate_plan',
      payload:       { userId, orderId, reason: 'write_to_db_failed' },
      error_msg:     err.message,
      retry_count:   0,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    }).catch(dlErr => console.error('[habitEngine] CRITICAL: dead_letter insert also failed:', dlErr.message));
    throw err;
  } finally {
    await releaseLock(lockId);
  }
}

module.exports = { generateHabitPlan, adaptTodayTask, retryDeadLetters };
