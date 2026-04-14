// ============================================================
// taskTemplates.js — Behavioral Engine v5
//
// What changed from v4:
//   v5.1 — DIET-AWARE PRODUCT SELECTION (root fix)
//     • selectPrimaryProduct() now filters by diet compatibility BEFORE
//       picking the top product. A vegan user ordering whey+muesli will
//       never get whey or dairy-muesli as primary — peanut_butter is
//       chosen as the first compatible product instead.
//     • selectSecondaryProduct() applies the same diet filter.
//
//   v5.2 — COMPLETE DIET GUARD (guardDietPref expanded)
//     • Previously only whey was blocked for vegan.
//     • Now: muesli (milk-based) and protein_bar (contains whey/milk)
//       are ALSO blocked for vegan.
//     • veg diet: no eggs in fallback (already correct, kept).
//     • non_veg: all products allowed.
//
//   v5.3 — VEGAN MUESLI ADAPTATION (not rejection)
//     • Vegan + muesli order → "60g Alpino Muesli with 200ml soy milk"
//       (adaptation, not a blocked fallback).
//     • New action block: muesli_vegan — same product, soy milk swap.
//
//   v5.4 — PRODUCT RULE TABLE (single source of truth)
//     • PRODUCT_DIET_RULES defines which diets each product is allowed
//       for and what the correct diet-swap is.
//     • All selection + guard logic reads from this table.
//     • To add a new product: add one entry here, nowhere else.
//
//   v5.5 — WHEY BLOCK: quantity instruction also fixed
//     • whey_easy was "1 scoop in 200ml MILK" — dairy, not just whey.
//       Changed to water. Dairy-specific instruction only shown to veg/non_veg.
//
// Out of scope here (belongs in habitEngine.js):
//   - Consumption tracking (DB write)
//   - Reorder trigger (DB + notification layer)
// ============================================================


// ─────────────────────────────────────────────
// PRODUCT DIET RULES — single source of truth
//
// allowed_diets: diets for which this product CAN be used as-is
// swap: what to do when the product is blocked by diet
//   swap.block = 'vegan'        → block for vegan users
//   swap.product = 'pb'         → replace with this product key
//   swap.adapt   = 'muesli_vegan' → use a diet-adapted block instead of blocking
//
// To add a new product: add one entry here. That's it.
// ─────────────────────────────────────────────
const PRODUCT_DIET_RULES = {
  whey: {
    allowed_diets: ['veg', 'non_veg'],    // dairy-based
    diet_swap: {
      vegan: { action: 'replace', with: 'peanut_butter' },
    },
  },
  peanut_butter: {
    allowed_diets: ['veg', 'vegan', 'non_veg'],  // universally safe
    diet_swap: {},
  },
  protein_bar: {
    // Assume Alpino bars contain whey/milk solids — treat as non-vegan
    // If a vegan-certified bar is added later, update this entry.
    allowed_diets: ['veg', 'non_veg'],
    diet_swap: {
      vegan: { action: 'replace', with: 'peanut_butter' },
    },
  },
  muesli: {
    // Standard muesli uses cow's milk — not vegan as-is.
    // BUT: vegan users can use soy milk → adapt, not reject.
    allowed_diets: ['veg', 'non_veg'],
    diet_swap: {
      vegan: { action: 'adapt', with: 'muesli_vegan' },  // soy milk version
    },
  },
};

// Helper: is a product usable for a given diet?
// "Usable" = allowed as-is OR adaptable (a diet-safe block variant exists).
// Only truly blocked products (action: 'replace') return false.
function isProductAllowedForDiet(productKey, diet_pref) {
  const rule = PRODUCT_DIET_RULES[productKey];
  if (!rule) return true; // unknown product → don't block

  if (rule.allowed_diets.includes(diet_pref)) return true; // allowed as-is

  const swap = rule.diet_swap?.[diet_pref];
  if (!swap) return true; // no rule defined → don't block

  // 'adapt' = product stays, instruction changes → still usable
  if (swap.action === 'adapt') return true;

  // 'replace' = product is incompatible → blocked
  return false;
}


// ─────────────────────────────────────────────
// ANCHOR MAP
// One primary timing per lifestyle. Habit = same cue daily.
// ─────────────────────────────────────────────
const LIFESTYLE_ANCHOR = {
  sedentary: 'evening_snack',  // home/student — consistent 5 PM slot
  active:    'post_workout',   // gym user — post-workout window
  athlete:   'post_workout',
};

const TIMING_LABEL = {
  before_10am:   'Before 10 AM',
  post_workout:  'Within 30 mins of finishing your workout',
  evening_snack: 'At 5 PM (your evening snack slot)',
  anytime:       'At any one meal today — your choice',
};


// ─────────────────────────────────────────────
// DIET-SAFE FALLBACK MAP
// Used when the user has no compatible product OR as the "OR" option in emails.
// Fallback rule: must require effort (not just "grab curd")
// veg: no eggs / non_veg: eggs ok / vegan: no dairy or whey
// ─────────────────────────────────────────────
const DIET_FALLBACK = {
  veg: {
    protein:  { item: 'cook 150g paneer bhurji (takes 10 mins)',              protein_g: 18 },
    light:    { item: 'prepare 200g curd + roasted cumin + chaat masala',     protein_g: 7  },
    carb_pro: { item: 'mix 1 glass sattu in water (needs sattu at home)',      protein_g: 10 },
  },
  non_veg: {
    protein:  { item: 'boil 3 eggs (takes 10 mins)',                          protein_g: 18 },
    light:    { item: 'boil 2 eggs',                                          protein_g: 12 },
    carb_pro: { item: 'boil 2 eggs + 1 roti',                                 protein_g: 14 },
  },
  vegan: {
    protein:  { item: 'cook 150g tofu scramble (takes 10 mins)',              protein_g: 15 },
    light:    { item: 'eat 30g roasted chana with lemon + chaat masala',      protein_g: 8  },
    carb_pro: { item: 'blend 1 glass soy milk + 1 banana',                    protein_g: 9  },
  },
};


// ─────────────────────────────────────────────
// ACTION BLOCKS
// quantity = real human instruction
// fallback_type = key into DIET_FALLBACK (resolved at runtime)
// ─────────────────────────────────────────────
const ACTION_BLOCKS = {

  // ── Peanut Butter — safe for ALL diets ──
  pb_easy: {
    product: 'peanut_butter',
    product_label: 'Alpino Peanut Butter',
    quantity: '2 tbsp on a roti or toast',
    protein_g: 8,
    fallback_type: 'light',
  },
  pb_push: {
    product: 'peanut_butter',
    product_label: 'Alpino Peanut Butter',
    quantity: '2 tbsp + 1 banana',
    protein_g: 9,
    fallback_type: 'protein',
  },
  pb_push_high: {
    product: 'peanut_butter',
    product_label: 'Alpino Peanut Butter',
    quantity: '3 tbsp stirred into 50g oats (dry weight)',
    protein_g: 13,
    fallback_type: 'carb_pro',
  },
  pb_recovery: {
    product: 'peanut_butter',
    product_label: 'Alpino Peanut Butter',
    quantity: '1 tbsp stirred into dal or sabzi',
    protein_g: 4,
    fallback_type: 'light',
  },

  // ── Whey — veg + non_veg only. Blocked for vegan. ──
  // FIX v5.5: base instruction uses water (not milk) — milk is offered as a
  // performance upgrade note for veg/non_veg inside the description, not baked in.
  whey_easy: {
    product: 'whey',
    product_label: 'Whey Protein',
    quantity: '1 scoop in 250ml water (or 200ml milk for more protein)',
    protein_g: 24,
    fallback_type: 'protein',
  },
  whey_push: {
    product: 'whey',
    product_label: 'Whey Protein',
    quantity: '1 scoop in 200ml water',
    protein_g: 24,
    fallback_type: 'protein',
  },
  whey_push_high: {
    product: 'whey',
    product_label: 'Whey Protein',
    quantity: '1.5 scoops in 300ml water',
    protein_g: 36,
    fallback_type: 'protein',
  },
  whey_recovery: {
    product: 'whey',
    product_label: 'Whey Protein',
    quantity: '1 scoop in 300ml water — sip slowly',
    protein_g: 24,
    fallback_type: 'light',
  },

  // ── Protein Bar — veg + non_veg only. Blocked for vegan. ──
  bar_easy: {
    product: 'protein_bar',
    product_label: 'Alpino Protein Bar',
    quantity: '1 bar',
    protein_g: 15,
    fallback_type: 'light',
  },
  bar_push: {
    product: 'protein_bar',
    product_label: 'Alpino Protein Bar',
    quantity: '1 bar immediately after finishing your workout',
    protein_g: 15,
    fallback_type: 'protein',
  },

  // ── Muesli — veg + non_veg: cow's milk. Vegan: soy milk (separate block). ──
  muesli_easy: {
    product: 'muesli',
    product_label: 'Alpino Muesli',
    quantity: '60g with 200ml milk',
    protein_g: 12,
    fallback_type: 'carb_pro',
  },
  muesli_push: {
    product: 'muesli',
    product_label: 'Alpino Muesli',
    quantity: '80g with 250ml milk + 1 banana sliced in',
    protein_g: 15,
    fallback_type: 'carb_pro',
  },
  muesli_recovery: {
    product: 'muesli',
    product_label: 'Alpino Muesli',
    quantity: '50g with 200ml milk — light bowl',
    protein_g: 10,
    fallback_type: 'carb_pro',
  },
  // FIX v5.3: Vegan muesli adaptation — soy milk, same product.
  // Used when diet=vegan AND muesli is the ordered product.
  // This is an adaptation (not a rejection) — user still uses their product.
  muesli_vegan: {
    product: 'muesli',
    product_label: 'Alpino Muesli',
    quantity: '60g with 200ml unsweetened soy milk',
    protein_g: 11,
    fallback_type: 'carb_pro',
  },
  muesli_vegan_push: {
    product: 'muesli',
    product_label: 'Alpino Muesli',
    quantity: '80g with 250ml soy milk + 1 banana sliced in',
    protein_g: 14,
    fallback_type: 'carb_pro',
  },
};


// ─────────────────────────────────────────────
// PRODUCT → BLOCK MAP
// Maps product key + day type → action block key.
// All day types must be covered (no silent gaps).
// ─────────────────────────────────────────────
const PRODUCT_BLOCK_MAP = {
  peanut_butter: {
    easy:       'pb_easy',
    push:       'pb_push',
    push_high:  'pb_push_high',
    recovery:   'pb_recovery',
    comeback:   'pb_recovery',
  },
  whey: {
    easy:       'whey_easy',
    push:       'whey_push',
    push_high:  'whey_push_high',
    recovery:   'whey_recovery',
    comeback:   'whey_easy',
  },
  protein_bar: {
    easy:       'bar_easy',
    push:       'bar_push',
    push_high:  'bar_push',
    recovery:   'bar_easy',
    comeback:   'bar_easy',
  },
  muesli: {
    easy:       'muesli_easy',
    push:       'muesli_push',
    push_high:  'muesli_push',
    recovery:   'muesli_recovery',
    comeback:   'muesli_easy',
  },
};


// ─────────────────────────────────────────────
// CATEGORY → PRODUCT KEY MAP
// DB stores category as canonical strings.
// PRODUCT_BLOCK_MAP uses keys: 'peanut_butter', 'protein_bar', 'whey', 'muesli'.
// This map translates. Without it every lookup silently falls back to peanut_butter.
// ─────────────────────────────────────────────
const CATEGORY_TO_PRODUCT_KEY = {
  // Exact canonical values (set by deriveCategory in server.js)
  whey:          'whey',
  peanut_butter: 'peanut_butter',
  protein_bar:   'protein_bar',
  muesli:        'muesli',
  // Legacy / generic values that may exist in older rows
  protein:       'whey',
  snack:         'protein_bar',
};


// ─────────────────────────────────────────────
// DIET GUARD — resolves a block key to a diet-safe alternative
//
// v5: now handles all blocked products, not just whey.
// Reading order:
//   1. Look up the block in ACTION_BLOCKS.
//   2. Check PRODUCT_DIET_RULES for the block's product.
//   3. If diet_swap.action === 'adapt', use the adapted block key directly.
//   4. If diet_swap.action === 'replace', remap to the replacement product's
//      block for the same day type.
//   5. If no swap needed, return original blockKey.
// ─────────────────────────────────────────────
function guardDietPref(blockKey, diet_pref, dayType) {
  const block = ACTION_BLOCKS[blockKey];
  if (!block) return blockKey; // unknown block — pass through

  const rule = PRODUCT_DIET_RULES[block.product];
  if (!rule) return blockKey; // no rule — pass through

  if (rule.allowed_diets.includes(diet_pref)) return blockKey; // allowed — no swap needed

  const swap = rule.diet_swap?.[diet_pref];
  if (!swap) return blockKey; // no swap defined — pass through (should not happen)

  if (swap.action === 'adapt') {
    // Use a diet-adapted block for the same product (e.g. muesli_vegan).
    // Try day-type specific variant first (muesli_vegan_push), then base adapted
    // block (muesli_vegan), then fall through to replace logic if neither exists.
    const adaptedVariant = `${swap.with}_${dayType}`;
    if (ACTION_BLOCKS[adaptedVariant]) return adaptedVariant;
    if (ACTION_BLOCKS[swap.with]) return swap.with;
    // No adapted block found — fall through to replace logic below
  }

  if (swap.action === 'replace' || swap.action === 'adapt') {
    // Replace with the first diet-safe product's block for this day type
    const replacementProduct = swap.with; // e.g. 'peanut_butter'
    const replacementBlockMap = PRODUCT_BLOCK_MAP[replacementProduct];
    if (replacementBlockMap) {
      return replacementBlockMap[dayType] || replacementBlockMap['easy'];
    }
  }

  // Final safety net
  return PRODUCT_BLOCK_MAP['peanut_butter'][dayType] || 'pb_easy';
}


// ─────────────────────────────────────────────
// PRIMARY PRODUCT SELECTOR — diet-aware
//
// v5 FIX: Filter by diet BEFORE picking the top product.
// Priority order:
//   1. Products the user ordered that are compatible with their diet
//   2. If none compatible → peanut_butter (universally safe)
//   3. Quantity-ranked within compatible set
// ─────────────────────────────────────────────
function selectPrimaryProduct(productCategories, productQuantities, diet_pref) {
  if (!productCategories || productCategories.length === 0) return 'peanut_butter';

  // Translate categories → product keys
  const productKeys = [...new Set(
    productCategories
      .map(cat => CATEGORY_TO_PRODUCT_KEY[cat])
      .filter(Boolean)
  )];

  if (productKeys.length === 0) return 'peanut_butter';

  // Filter to only diet-compatible products
  const compatibleKeys = productKeys.filter(key => isProductAllowedForDiet(key, diet_pref));

  // If nothing is compatible (e.g. vegan orders only whey + protein_bar):
  // peanut_butter is universally safe and is always in PRODUCT_BLOCK_MAP
  if (compatibleKeys.length === 0) {
    console.warn(`[taskTemplates] No diet-compatible product found for diet="${diet_pref}" from [${productKeys.join(',')}]. Defaulting to peanut_butter.`);
    return 'peanut_butter';
  }

  // Rank by quantity (highest first) within compatible set
  // productQuantities keys are category strings, so we need to map back
  const categoryForKey = {};
  for (const cat of productCategories) {
    const key = CATEGORY_TO_PRODUCT_KEY[cat];
    if (key && !categoryForKey[key]) categoryForKey[key] = cat;
  }

  const topKey = [...compatibleKeys].sort((a, b) => {
    const qtyA = productQuantities[categoryForKey[a]] || 0;
    const qtyB = productQuantities[categoryForKey[b]] || 0;
    return qtyB - qtyA;
  })[0];

  return topKey;
}


// ─────────────────────────────────────────────
// SECONDARY PRODUCT SURFACER — diet-aware
// Surfaces on Day 3 + Day 6 (push days — user is engaged)
// Never replaces primary — only adds a tip line
// ─────────────────────────────────────────────
function getSecondaryProduct(productCategories, primaryProductKey, absoluteDayNumber, diet_pref) {
  if (!productCategories || productCategories.length < 2) return null;
  const cyclePos = ((absoluteDayNumber - 1) % 7) + 1;
  if (cyclePos !== 3 && cyclePos !== 6) return null;

  // Find a secondary category that maps to a different diet-safe product key
  const secondaryCategory = productCategories.find(cat => {
    const key = CATEGORY_TO_PRODUCT_KEY[cat] || 'peanut_butter';
    return key !== primaryProductKey && isProductAllowedForDiet(key, diet_pref);
  });

  return secondaryCategory ? (CATEGORY_TO_PRODUCT_KEY[secondaryCategory] || null) : null;
}


// ─────────────────────────────────────────────
// IDENTITY LINES — persona × day_type
// ─────────────────────────────────────────────
const IDENTITY_LINES = {
  sedentary: {
    easy:       "You're someone who doesn't skip — even on ordinary days.",
    push:       "You eat with intention. Most people don't.",
    push_high:  "You didn't let a busy week break the habit. That's discipline.",
    recovery:   "Rest days are in the plan. You treat them that way.",
    reflection: "You stuck to it. 7 days is more than most people do in a year.",
    comeback:   "You came back. That's the whole game.",
  },
  active: {
    easy:       "You show up — even on off-days. That's the difference.",
    push:       "You don't leave training and skip protein. That's your standard.",
    push_high:  "Your body is trained and fueled. That combination is rare.",
    recovery:   "Recovery nutrition is still nutrition. You know this.",
    reflection: "7 days. The habit is automatic. You just proved it.",
    comeback:   "One skip. Came back. That's what consistent looks like.",
  },
  athlete: {
    easy:       "Structured easy days are a deliberate decision. You made it.",
    push:       "You train hard because you fuel right. Non-negotiable.",
    push_high:  "Peak days need peak input. You don't half-effort this.",
    recovery:   "Deliberate recovery is a training variable. You treat it that way.",
    reflection: "Week complete. This is your baseline now — not an achievement.",
    comeback:   "Athletes miss days. They don't miss comebacks.",
  },
};


// ─────────────────────────────────────────────
// PSYCH CLOSE
// ─────────────────────────────────────────────
const PSYCH_CLOSE = {
  easy:       "No pressure. Just show up.",
  push:       "This is where results start showing.",
  push_high:  "This is your standard now — not an effort.",
  recovery:   "Light day. Body is adapting. Trust it.",
  comeback:   "You came back. That's the hard part done.",
};


// ─────────────────────────────────────────────
// REFLECTION BODY — no task, identity + proof
// ─────────────────────────────────────────────
function buildReflectionBody({ identity, memoryPrefix }) {
  return (
    `${memoryPrefix ? memoryPrefix + '\n' : ''}` +
    `${identity}\n\n` +
    `👉 Today: no new instruction.\n` +
    `Keep doing exactly what you've been doing.\n\n` +
    `📊 Week 1 done. You built a nutrition habit most people never start.\n` +
    `— That's not a challenge anymore. That's who you are.`
  );
}


// ─────────────────────────────────────────────
// EMAIL BODY GENERATOR
// ─────────────────────────────────────────────
function generateEmailBody({ identity, anchor_label, product_label, quantity, fallback_item, protein_g, psych_close, memoryPrefix, secondary_line }) {
  return (
    `${memoryPrefix ? memoryPrefix + '\n' : ''}` +
    `${identity}\n\n` +
    `👉 ${anchor_label}:\n` +
    `• ${quantity} ${product_label}\n` +
    `• OR ${fallback_item}\n` +
    `${secondary_line ? '\n' + secondary_line + '\n' : ''}` +
    `\n📊 Done: ~${protein_g}g protein\n` +
    `— ${psych_close}`
  );
}


// ─────────────────────────────────────────────
// MEMORY PREFIX
// ─────────────────────────────────────────────
function getMemoryPrefix(userBehavior) {
  const { currentStreak, skippedYesterday, completedCount } = userBehavior;
  if (skippedYesterday)     return `↩️ Welcome back. Yesterday was a miss. Today is not.`;
  if (currentStreak >= 5)   return `🔥 ${currentStreak}-day streak — keep it going`;
  if (currentStreak >= 3)   return `🔥 ${currentStreak}-day streak. You're building something real.`;
  if (completedCount === 0) return `👋 Day 1. One action. That's all.`;
  return '';
}


// ─────────────────────────────────────────────
// DECISION ENGINE
// ─────────────────────────────────────────────
const BASE_CYCLE = { 1:'easy', 2:'easy', 3:'push', 4:'recovery', 5:'push', 6:'push', 7:'reflection' };

function decideDayType(absoluteDayNumber, userBehavior, planType) {
  const { skippedYesterday, fatigueScore, currentStreak, complianceScore = 1.0 } = userBehavior;
  if (fatigueScore > 2) return 'recovery';
  if (skippedYesterday) return 'comeback';

  const cyclePos = ((absoluteDayNumber - 1) % 7) + 1;
  const baseType = BASE_CYCLE[cyclePos] || 'easy';

  // push_high needs streak AND compliance — not just streak
  if (baseType === 'push' && currentStreak >= 5 && complianceScore >= 0.7) return 'push_high';
  if (planType === 'aggressive' && currentStreak > 5 && baseType === 'easy') return 'push';
  return baseType;
}


// ─────────────────────────────────────────────
// MAIN: getTaskForDay()
// ─────────────────────────────────────────────
function getTaskForDay({
  goal              = 'general_health',
  lifestyle         = 'sedentary',
  diet_pref         = 'veg',
  plan_type         = 'normal',
  productCategories = [],
  productQuantities = {},
  absoluteDayNumber = 1,
  userBehavior      = {},
}) {
  const behavior = {
    skippedYesterday: false,
    fatigueScore:     0,
    currentStreak:    0,
    completedCount:   0,
    complianceScore:  1.0,
    ...userBehavior,
  };

  const safeLifestyle = IDENTITY_LINES[lifestyle]  ? lifestyle  : 'sedentary';
  const safeDiet      = DIET_FALLBACK[diet_pref]   ? diet_pref  : 'veg';
  const dayType       = decideDayType(absoluteDayNumber, behavior, plan_type);

  // Reflection — identity only, no task
  if (dayType === 'reflection') {
    return {
      day_number:     absoluteDayNumber,
      task_type:      'reflection',
      dosage:         null,
      dosage_label:   null,
      primary_product: null,
      description:    buildReflectionBody({
        identity:      IDENTITY_LINES[safeLifestyle].reflection,
        memoryPrefix:  getMemoryPrefix(behavior),
      }),
      nutrient_focus: 'identity',
    };
  }

  // Primary product — diet-aware, quantity-ranked
  // v5 FIX: diet compatibility is checked BEFORE picking top product
  const primaryProduct = selectPrimaryProduct(productCategories, productQuantities, safeDiet);

  // Block selection — get raw block for this product + day type
  const productMap  = PRODUCT_BLOCK_MAP[primaryProduct] || PRODUCT_BLOCK_MAP['peanut_butter'];
  const rawBlockKey = productMap[dayType] || productMap['easy'];

  // Apply diet guard — handles adapt (muesli_vegan) and replace (whey → pb) cases
  const blockKey = guardDietPref(rawBlockKey, safeDiet, dayType);
  const block    = ACTION_BLOCKS[blockKey];

  if (!block) {
    // Should never happen — log loudly and use safe fallback
    console.error(`[taskTemplates] MISSING ACTION BLOCK: key="${blockKey}" product="${primaryProduct}" day=${absoluteDayNumber} diet="${safeDiet}". Using pb_easy.`);
    const safeBlock = ACTION_BLOCKS['pb_easy'];
    return buildTaskResult({ absoluteDayNumber, dayType, safeLifestyle, safeDiet, block: safeBlock, productCategories, primaryProduct: 'peanut_butter', absoluteDayNumber, behavior, productQuantities });
  }

  // Fallback — diet-aware, friction-based
  const fallbackDef = DIET_FALLBACK[safeDiet][block.fallback_type] || DIET_FALLBACK[safeDiet].light;

  // Anchor timing — consistent per lifestyle
  const anchorTiming = dayType === 'recovery' ? 'anytime' : (LIFESTYLE_ANCHOR[safeLifestyle] || 'evening_snack');
  const anchor_label = TIMING_LABEL[anchorTiming];

  // Secondary product line — diet-aware
  const secondaryProduct = getSecondaryProduct(productCategories, primaryProduct, absoluteDayNumber, safeDiet);
  let secondary_line = null;
  if (secondaryProduct) {
    const secMap      = PRODUCT_BLOCK_MAP[secondaryProduct] || PRODUCT_BLOCK_MAP['peanut_butter'];
    const secRawKey   = secMap[dayType] || secMap['push'];
    const secBlockKey = guardDietPref(secRawKey, safeDiet, dayType);
    const secBlock    = ACTION_BLOCKS[secBlockKey];
    if (secBlock) {
      secondary_line = `💡 Also have ${secBlock.product_label}? Stack: add ${secBlock.quantity} — works well today.`;
    }
  }

  const description = generateEmailBody({
    identity:      IDENTITY_LINES[safeLifestyle][dayType] || IDENTITY_LINES[safeLifestyle]['easy'],
    anchor_label,
    product_label: block.product_label,
    quantity:      block.quantity,
    fallback_item: fallbackDef.item,
    protein_g:     block.protein_g,
    psych_close:   PSYCH_CLOSE[dayType] || PSYCH_CLOSE['easy'],
    memoryPrefix:  getMemoryPrefix(behavior),
    secondary_line,
  });

  return {
    day_number:      absoluteDayNumber,
    task_type:       dayType,
    dosage:          null,
    dosage_label:    block.quantity,
    primary_product: block.product,  // always the actual product in the task (after any diet swap)
    description,
    nutrient_focus:  'protein',
  };
}


// ─────────────────────────────────────────────
// BATCH: getTemplate()
// ─────────────────────────────────────────────
function getTemplate({ goal, lifestyle, diet_pref, plan_type, productCategories = [], productQuantities = {} }) {
  return Array.from({ length: 7 }, (_, i) =>
    getTaskForDay({
      goal, lifestyle, diet_pref, plan_type,
      productCategories, productQuantities,
      absoluteDayNumber: i + 1,
      userBehavior: {
        skippedYesterday: false,
        fatigueScore:     0,
        currentStreak:    i,
        completedCount:   i,
        complianceScore:  i >= 4 ? 0.85 : 0.5,
      },
    })
  );
}

module.exports = { getTemplate, getTaskForDay, isProductAllowedForDiet, PRODUCT_DIET_RULES };
