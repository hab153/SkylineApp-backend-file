'use strict';

const understandRequest = require('./UnderstandRequest');
const planRequest      = require('./PlanRequest');

// ────────────────────────────────────────────────────────────────
// FIELD ORDER — matches the schema exactly
// ────────────────────────────────────────────────────────────────

const FIELD_ORDER = [
    'targetEntity',
    'problem',
    'intent',
    'location',
    'industry',
    'qualification',
    'signal',
    'quantity',
    'information',
    'exclusions',
    'constraints',
];

const FIELD_LABELS = {
    targetEntity:  { icon: '🎯', label: 'Target entity' },
    problem:       { icon: '📌', label: 'Problem' },
    intent:        { icon: '💡', label: 'Intent' },
    industry:      { icon: '🏭', label: 'Industry' },
    qualification: { icon: '✅', label: 'Qualification' },
    signal:        { icon: '📡', label: 'Signal' },
    quantity:      { icon: '🔢', label: 'Quantity' },
    information:   { icon: '📋', label: 'Information' },
    exclusions:    { icon: '🚫', label: 'Exclusions' },
    constraints:   { icon: '📎', label: 'Constraints' },
};

const DEFAULT_FIELD_ICON = '📝';

function titleCase(key) {
    return key.charAt(0).toUpperCase() + key.slice(1);
}

function formatLocation(loc) {
    if (!loc || (!loc.city && !loc.country)) return null;
    const city = loc.city || '—';
    const country = loc.country || '—';
    return `📍 Location: ${city}, ${country}`;
}

function formatField(key, value) {
    if (key === 'location') return formatLocation(value);

    const meta = FIELD_LABELS[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };

    if (Array.isArray(value)) {
        const items = value.filter(v => typeof v === 'string' && v.trim());
        if (items.length === 0) return null;
        return `${meta.icon} ${meta.label}: ${items.join(', ')}`;
    }

    if (typeof value === 'string' && value.trim()) {
        return `${meta.icon} ${meta.label}: ${value}`;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return `${meta.icon} ${meta.label}: ${value}`;
    }

    return null;
}

function buildReply(result) {
    if (!result || !result.targetEntity) {
        return '⚠️ Could not determine a target entity from your message.';
    }

    const lines = [];

    for (const key of FIELD_ORDER) {
        const line = formatField(key, result[key]);
        if (line) lines.push(line);
    }

    // Any extra fields the model invents — render at the end with default icon
    const extraKeys = Object.keys(result).filter(k => !FIELD_ORDER.includes(k));
    for (const key of extraKeys) {
        const line = formatField(key, result[key]);
        if (line) lines.push(line);
    }

    return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress, options = {}) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    try {
        // ── STEP 1: Understand the request ──
        const understanding = await understandRequest(message, {
            history, userProfile, onProgress, options,
        });

        console.log('[Orchestrator] Understanding result:', understanding);

        // ── STEP 2: Plan based on the understanding ──
        const planResult = await planRequest(understanding, {
            message,
            history,
            userProfile,
            onProgress,
            options,
        });

        console.log('[Orchestrator] Plan result:', planResult);

        const plan = planResult.plan;
        const finalUnderstanding = planResult.understanding || understanding;

        // ── STEP 3: Render the reply from the understanding ──
        const reply = buildReply(finalUnderstanding);
        console.log('[Orchestrator] Rendered reply:\n' + reply);

        return {
            reply,
            updatedHistory: history || [],
            meta: {
                understanding: finalUnderstanding,
                plan,
            },
        };
    } catch (error) {
        console.error('[Orchestrator] Request failed');
        console.error('[Orchestrator] Error name:', error.name);
        console.error('[Orchestrator] Error message:', error.message);
        console.error('[Orchestrator] Full error:', error);
        throw error;
    }
}

module.exports = { generateFreeResponse };
