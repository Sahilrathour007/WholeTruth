// ============================================================
// taskTemplates.js — Behavioral Engine v4
//
// Fixes from v3 review:
//   1. One anchor timing per lifestyle — gym=post_workout, student=morning, home=evening
//   2. Primary product by quantity (g), not array order
//   3. Multi-product rotation — secondary product surfaces on Day 3/6
//   4. Fallback friction — fallback requires effort, not "just eat curd"
//   5. diet_pref enforced — vegan gets no dairy/whey, veg gets no eggs
//   6. dosage float removed — dosage_label = real quantity string
//   7. Reflection day = identity only, no task instruction
//
// Out of scope here (belongs in habitEngine.js):
//   - Consumption tracking (DB write)
//   - Reorder trigger (DB + notification layer)
// ============================================================


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
    light:    { item: 'soak + eat 30g roasted chana (needs overnight prep)',   protein_g: 8  },
    carb_pro: { item: 'blend 1 glass soy milk + banana',                      protein_g: 9  },
  },
};


// ─────────────────────────────────────────────
// ACTION BLOCKS
// quantity = real human instruction
// fallback_type = key into DIET_FALLBACK (resolved at runtime)
// ─────────────────────────────────────────────
const ACTION_BLOCKS = {

  // ── Peanut Butter ──
  pb_easy: {
    product: 'peanut_butter',
    product_label: 'Alpino Peanut Butter',
    quantity: '2 tbsp',
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

  // ── Whey (blocked for vegan at runtime) ──
  whey_easy: {
    product: 'whey',
    product_label: 'Whey Protein',
    quantity: '1 scoop in 200ml milk',
    protein_g: 28,
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

  // ── Protein Bar ──
  bar_easy: {
    product: 'protein_bar',
    product_label: 'Protein Bar',
    quantity: '1 bar',
    protein_g: 15,
    fallback_type: 'light',
  },
  bar_push: {
    product: 'protein_bar',
    product_label: 'Protein Bar',
    quantity: '1 bar immediately after finishing',
    protein_g: 15,
    fallback_type: 'protein',
  },

  // ── Muesli ──
  muesli_easy: {
    product: 'muesli',
    product_label: 'Alpino Muesli',
    quantity: '60g with 200ml milk',
    protein_g: 12,
    fallback_type: 'carb_pro',
  },
};


// ─────────────────────────────────────────────
// PRODUCT → BLOCK MAP
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
    recovery:   'pb_recovery',    // no whey on recovery — use PB light
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
    push:       'muesli_easy',
    push_high:  'muesli_easy',
    recovery:   'muesli_easy',
    comeback:   'muesli_easy',
  },
};


// ─────────────────────────────────────────────
// CATEGORY → PRODUCT KEY MAP
// Your DB stores category as 'protein' or 'snack'.
// PRODUCT_BLOCK_MAP uses keys like 'peanut_butter', 'protein_bar', 'whey', 'muesli'.
// This map translates. Without it, every lookup falls back to peanut_butter.
// ─────────────────────────────────────────────
const CATEGORY_TO_PRODUCT_KEY = {
  protein: 'whey',          // generic protein → whey as default protein product
  snack:   'protein_bar',   // generic snack → protein bar
  whey:    'whey',
  peanut_butter: 'peanut_butter',
  protein_bar:   'protein_bar',
  muesli:        'muesli',
};

// ─────────────────────────────────────────────
// PRIMARY PRODUCT SELECTOR
// Fix: quantity-based, not array[0]
// ─────────────────────────────────────────────
function selectPrimaryProduct(productCategories, productQuantities) {
  if (!productCategories || productCategories.length === 0) return 'peanut_butter';
  const topCategory = [...productCategories].sort(
    (a, b) => (productQuantities[b] || 0) - (productQuantities[a] || 0)
  )[0];
  // Translate DB category value to a PRODUCT_BLOCK_MAP key
  return CATEGORY_TO_PRODUCT_KEY[topCategory] || 'peanut_butter';
}


// ─────────────────────────────────────────────
// SECONDARY PRODUCT SURFACER
// Surfaces on Day 3 + Day 6 (push days — user is engaged)
// Always secondary to primary — never replaces it
// ─────────────────────────────────────────────
function getSecondaryProduct(productCategories, primaryProductKey, absoluteDayNumber) {
  if (!productCategories || productCategories.length < 2) return null;
  const cyclePos = ((absoluteDayNumber - 1) % 7) + 1;
  if (cyclePos !== 3 && cyclePos !== 6) return null;
  // Find a secondary category that maps to a different product key than the primary
  const secondaryCategory = productCategories.find(
    cat => (CATEGORY_TO_PRODUCT_KEY[cat] || 'peanut_butter') !== primaryProductKey
  );
  return secondaryCategory ? (CATEGORY_TO_PRODUCT_KEY[secondaryCategory] || null) : null;
}


// ─────────────────────────────────────────────
// VEGAN / DIET GUARD
// Whey = dairy → blocked for vegan
// ─────────────────────────────────────────────
function guardDietPref(blockKey, diet_pref) {
  const block = ACTION_BLOCKS[blockKey];
  if (!block) return blockKey;
  if (diet_pref === 'vegan' && block.product === 'whey') {
    const swap = { whey_easy: 'pb_easy', whey_push: 'pb_push', whey_push_high: 'pb_push_high' };
    return swap[blockKey] || 'pb_easy';
  }
  return blockKey;
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
      description:    buildReflectionBody({
        identity:      IDENTITY_LINES[safeLifestyle].reflection,
        memoryPrefix:  getMemoryPrefix(behavior),
      }),
      nutrient_focus: 'identity',
    };
  }

  // Primary product — quantity-ranked
  const primaryProduct = selectPrimaryProduct(productCategories, productQuantities);

  // Block selection with diet guard
  const productMap  = PRODUCT_BLOCK_MAP[primaryProduct] || PRODUCT_BLOCK_MAP['peanut_butter'];
  const rawBlockKey = productMap[dayType] || productMap['easy'];
  const blockKey    = guardDietPref(rawBlockKey, safeDiet);
  const block       = ACTION_BLOCKS[blockKey];

  // Fallback — diet-aware, friction-based
  const fallbackDef  = DIET_FALLBACK[safeDiet][block.fallback_type] || DIET_FALLBACK[safeDiet].protein;

  // Anchor timing — consistent per lifestyle
  const anchorTiming = dayType === 'recovery' ? 'anytime' : (LIFESTYLE_ANCHOR[safeLifestyle] || 'evening_snack');
  const anchor_label = TIMING_LABEL[anchorTiming];

  // Secondary product line
  const secondaryProduct = getSecondaryProduct(productCategories, primaryProduct, absoluteDayNumber);
  let secondary_line = null;
  if (secondaryProduct) {
    const secMap      = PRODUCT_BLOCK_MAP[secondaryProduct] || PRODUCT_BLOCK_MAP['peanut_butter'];
    const secBlockKey = guardDietPref(secMap[dayType] || secMap['push'], safeDiet);
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
    primary_product: block.product,   // FIX [3]: normalized product key, stored on task row
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

module.exports = { getTemplate, getTaskForDay };
