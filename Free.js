'use strict';

const understandRequest = require('./UnderstandRequest');
const planRequest      = require('./PlanRequest');
const summaryRequest   = require('./Summary');

// ────────────────────────────────────────────────────────────────
// UNDERSTANDING FIELDS
// ────────────────────────────────────────────────────────────────

const UNDERSTANDING_ORDER = [
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

const UNDERSTANDING_LABELS = {
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

// ────────────────────────────────────────────────────────────────
// PLANNING FIELDS
// ────────────────────────────────────────────────────────────────

const PLANNING_ORDER = [
    'strategy',
    'source',
    'query',
    'evidenceSearch',
    'allocation',
    'searchExpansion',
    'steps',
    'action',
];

const PLANNING_LABELS = {
    strategy:        { icon: '🧭', label: 'Strategy' },
    source:          { icon: '🔗', label: 'Source' },
    query:           { icon: '🔍', label: 'Query' },
    evidenceSearch:  { icon: '🔬', label: 'Evidence Search' },
    allocation:      { icon: '📊', label: 'Allocation' },
    searchExpansion: { icon: '🌐', label: 'Search Expansion' },
    steps:           { icon: '🪜', label: 'Steps' },
    action:          { icon: '⚡', label: 'Action' },
};

// ────────────────────────────────────────────────────────────────
// SUMMARY FIELDS
// ────────────────────────────────────────────────────────────────

const SUMMARY_ORDER = [
    'summary',
    'allocation',
];

const SUMMARY_LABELS = {
    summary:    { icon: '📝', label: 'Summary' },
    allocation: { icon: '📊', label: 'Allocation' },
};

const DEFAULT_FIELD_ICON = '📝';

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

function titleCase(key) {
    return key.charAt(0).toUpperCase() + key.slice(1);
}

function humanizeKey(key) {
    return key
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, c => c.toUpperCase())
        .trim();
}

function formatLocation(loc) {
    if (!loc || (!loc.city && !loc.country)) return null;
    const city = loc.city || '—';
    const country = loc.country || '—';
    return `📍 Location: ${city}, ${country}`;
}

function formatField(key, value, labels) {
    if (key === 'location') return formatLocation(value);

    const meta = labels[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };

    if (Array.isArray(value)) {
        const items = value
            .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
            .filter(Boolean);
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

// ────────────────────────────────────────────────────────────────
// RENDER: ALLOCATION OBJECT
// ────────────────────────────────────────────────────────────────

// Renders the allocation object. The current shape is:
//   {
//     requestedQuantity: <number>,
//     maxSearchCalls: <number>
//   }
// Any additional keys are rendered generically as a fallback.

function renderAllocation(allocation) {
    if (!allocation || typeof allocation !== 'object') return null;

    const lines = [];

    if (
        allocation.requestedQuantity !== undefined &&
        allocation.requestedQuantity !== null
    ) {
        lines.push(`   • Requested quantity: ${allocation.requestedQuantity}`);
    }

    if (
        allocation.maxSearchCalls !== undefined &&
        allocation.maxSearchCalls !== null
    ) {
        lines.push(`   • Max search calls: ${allocation.maxSearchCalls}`);
    }

    const knownKeys = ['requestedQuantity', 'maxSearchCalls'];
    for (const key of Object.keys(allocation)) {
        if (knownKeys.includes(key)) continue;
        const v = allocation[key];
        lines.push(`   • ${humanizeKey(key)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }

    if (lines.length === 0) return null;
    return ['📊 Allocation:', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// RENDER: UNDERSTANDING
// ────────────────────────────────────────────────────────────────

function renderUnderstanding(understanding) {
    if (!understanding || typeof understanding !== 'object') {
        return 'Understanding\n⚠️ No understanding data.';
    }

    const lines = [];

    for (const key of UNDERSTANDING_ORDER) {
        const line = formatField(key, understanding[key], UNDERSTANDING_LABELS);
        if (line) lines.push(line);
    }

    const extras = Object.keys(understanding).filter(k => !UNDERSTANDING_ORDER.includes(k));
    for (const key of extras) {
        const line = formatField(key, understanding[key], UNDERSTANDING_LABELS);
        if (line) lines.push(line);
    }

    if (lines.length === 0) return 'Understanding\n⚠️ No understanding data.';
    return ['Understanding', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// RENDER: PLANNING
// ────────────────────────────────────────────────────────────────

function renderPlanning(plan) {
    if (!plan || typeof plan !== 'object') {
        return 'Planning\n⚠️ No planning data.';
    }

    const lines = [];

    for (const key of PLANNING_ORDER) {
        const value = plan[key];
        if (value === undefined || value === null) continue;

        if (Array.isArray(value)) {
            const items = value
                .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
                .filter(Boolean);
            if (items.length === 0) continue;

            const meta = PLANNING_LABELS[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };

            if (key === 'query' || key === 'evidenceSearch' || key === 'searchExpansion' || key === 'steps') {
                lines.push(`${meta.icon} ${meta.label}:`);
                items.forEach((item, i) => lines.push(`   ${i + 1}. ${item}`));
                continue;
            }

            lines.push(`${meta.icon} ${meta.label}: ${items.join(', ')}`);
            continue;
        }

        if (typeof value === 'object') {
            if (key === 'allocation') {
                const block = renderAllocation(value);
                if (block) lines.push(block);
                continue;
            }

            const meta = PLANNING_LABELS[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };
            lines.push(`${meta.icon} ${meta.label}:`);
            for (const [k, v] of Object.entries(value)) {
                lines.push(`   • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
            continue;
        }

        const line = formatField(key, value, PLANNING_LABELS);
        if (line) lines.push(line);
    }

    const extras = Object.keys(plan).filter(k => !PLANNING_ORDER.includes(k));
    for (const key of extras) {
        const line = formatField(key, plan[key], PLANNING_LABELS);
        if (line) lines.push(line);
    }

    if (lines.length === 0) return 'Planning\n⚠️ No planning data.';
    return ['Planning', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// RENDER: SUMMARY
// ────────────────────────────────────────────────────────────────

function renderSummary(summary) {
    if (!summary || typeof summary !== 'object') {
        return 'Summary\n⚠️ No summary data.';
    }

    const lines = [];

    for (const key of SUMMARY_ORDER) {
        const value = summary[key];
        if (value === undefined || value === null) continue;

        const meta = SUMMARY_LABELS[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };

        // Allocation — use the dedicated renderer
        if (key === 'allocation') {
            const block = renderAllocation(value);
            if (block) lines.push(block);
            continue;
        }

        // Arrays
        if (Array.isArray(value)) {
            const items = value
                .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
                .filter(Boolean);
            if (items.length === 0) continue;
            lines.push(`${meta.icon} ${meta.label}:`);
            items.forEach((item, i) => lines.push(`   ${i + 1}. ${item}`));
            continue;
        }

        // Objects
        if (typeof value === 'object') {
            lines.push(`${meta.icon} ${meta.label}:`);
            for (const [k, v] of Object.entries(value)) {
                if (v === undefined || v === null || v === '') continue;
                lines.push(`   • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
            continue;
        }

        // Scalars — strings, numbers, booleans
        if (typeof value === 'string' && value.trim()) {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }
    }

    // Extra fields
    const extras = Object.keys(summary).filter(k => !SUMMARY_ORDER.includes(k));
    for (const key of extras) {
        const value = summary[key];
        if (value === undefined || value === null || value === '') continue;
        const meta = { icon: DEFAULT_FIELD_ICON, label: humanizeKey(key) };
        if (Array.isArray(value)) {
            const items = value.filter(Boolean);
            if (items.length === 0) continue;
            lines.push(`${meta.icon} ${meta.label}: ${items.join(', ')}`);
        } else if (typeof value === 'object') {
            lines.push(`${meta.icon} ${meta.label}:`);
            for (const [k, v] of Object.entries(value)) {
                if (v === undefined || v === null || v === '') continue;
                lines.push(`   • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
        } else {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
        }
    }

    if (lines.length === 0) return 'Summary\n⚠️ No summary data.';
    return ['Summary', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// COMPOSE FINAL REPLY — 3 SECTIONS
// ────────────────────────────────────────────────────────────────

function buildReply(understanding, plan, summary) {
    const sections = [
        renderUnderstanding(understanding),
        renderPlanning(plan),
    ];

    if (summary) {
        sections.push(renderSummary(summary));
    }

    return sections.join('\n\n');
}

// ────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress, options = {}) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    try {
        // ── STEP 1: Understand ──
        const understanding = await understandRequest(message, {
            history, userProfile, onProgress, options,
        });

        console.log('[Orchestrator] Understanding result:', understanding);

        // ── STEP 2: Plan ──
        const plan = await planRequest(understanding, {
            message, history, userProfile, onProgress, options,
        });

        console.log('[Orchestrator] Plan result:', plan);

        // ── STEP 3: Summary ──
        let summary = null;
        try {
            summary = await summaryRequest(understanding, plan, {
                message, history, userProfile, onProgress, options,
            });

            console.log('[Orchestrator] Summary result:', summary);
        } catch (summaryErr) {
            console.error('[Orchestrator] SummaryRequest failed:', summaryErr.message);
            summary = {
                summary: '',
                allocation: plan?.allocation ?? null,
            };
        }

        // ── STEP 4: Render all sections ──
        const reply = buildReply(understanding, plan, summary);
        console.log('[Orchestrator] Rendered reply:\n' + reply);

        return {
            reply,
            updatedHistory: history || [],
            meta: { understanding, plan, summary },
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
