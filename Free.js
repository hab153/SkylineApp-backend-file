'use strict';

const understandRequest = require('./UnderstandRequest');

// Pretty labels for known fields. Unknown fields fall back to their raw key.
const FIELD_LABELS = {
    targetEntity:  { icon: '🎯', label: 'Target entity' },
    problem:       { icon: '📌', label: 'Problem' },
    intent:        { icon: '💡', label: 'Intent' },
    industry:      { icon: '🏭', label: 'Industry' },
    qualification: { icon: '✅', label: 'Qualification' },
    signal:        { icon: '📡', label: 'Signal' },
};

function formatLine(key, value, labels) {
    const meta = labels[key] || { icon: '•', label: key };
    return `${meta.icon} ${meta.label}: ${value}`;
}

function formatLocation(loc) {
    if (!loc || (!loc.city && !loc.country)) return null;
    const city = loc.city || '—';
    const country = loc.country || '—';
    return `📍 Location: ${city}, ${country}`;
}

function buildReply(result) {
    if (!result || !result.targetEntity) {
        return '⚠️ Could not determine a target entity from your message.';
    }

    const lines = [];

    // 1. Render every string field in a stable order (known first, then unknown)
    const knownOrder = ['targetEntity', 'problem', 'intent', 'industry', 'qualification', 'signal'];
    const allKeys = Object.keys(result);

    const orderedKeys = [
        ...knownOrder.filter(k => allKeys.includes(k)),
        ...allKeys.filter(k => !knownOrder.includes(k) && k !== 'location'),
    ];

    for (const key of orderedKeys) {
        const value = result[key];
        if (typeof value === 'string' && value.trim()) {
            lines.push(formatLine(key, value, FIELD_LABELS));
        }
    }

    // 2. Handle location separately (it's an object)
    const locLine = formatLocation(result.location);
    if (locLine) lines.push(locLine);

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

module.exports = {
    generateFreeResponse,
};
