'use strict';

const understandRequest = require('./UnderstandRequest');

// Order matches the schema exactly
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
};

function formatLocation(loc) {
    if (!loc || (!loc.city && !loc.country)) return null;
    const city = loc.city || '—';
    const country = loc.country || '—';
    return `📍 Location: ${city}, ${country}`;
}

function formatField(key, value) {
    // location is special — object with city/country
    if (key === 'location') {
        return formatLocation(value);
    }

    // ✅ NEW: arrays — render as comma-separated list
    if (Array.isArray(value)) {
        const items = value.filter(v => typeof v === 'string' && v.trim());
        if (items.length === 0) return null;
        const meta = FIELD_LABELS[key] || { icon: '•', label: key };
        return `${meta.icon} ${meta.label}: ${items.join(', ')}`;
    }

    // strings
    if (typeof value === 'string' && value.trim()) {
        const meta = FIELD_LABELS[key] || { icon: '•', label: key };
        return `${meta.icon} ${meta.label}: ${value}`;
    }

    // numbers / booleans
    if (typeof value === 'number' || typeof value === 'boolean') {
        const meta = FIELD_LABELS[key] || { icon: '•', label: key };
        return `${meta.icon} ${meta.label}: ${value}`;
    }

    return null;
}

function buildReply(result) {
    if (!result || !result.targetEntity) {
        return '⚠️ Could not determine a target entity from your message.';
    }

    const lines = [];

    // Render in the exact schema order
    for (const key of FIELD_ORDER) {
        const line = formatField(key, result[key]);
        if (line) lines.push(line);
    }

    // Anything the model invents that isn't in FIELD_ORDER — render at the end
    const extraKeys = Object.keys(result).filter(k => !FIELD_ORDER.includes(k));
    for (const key of extraKeys) {
        const line = formatField(key, result[key]);
        if (line) lines.push(line);
    }

    return lines.join('\n');
}

async function generateFreeResponse(
    message,
    history,
    userProfile,
    onProgress,
    options = {}
) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    try {
        const result = await understandRequest(message, {
            history,
            userProfile,
            onProgress,
            options,
        });

        console.log('[Orchestrator] Understanding result:', result);

        const reply = buildReply(result);
        console.log('[Orchestrator] Rendered reply:\n' + reply);

        return {
            reply,
            updatedHistory: history || [],
            meta: result,
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
