'use strict';

const understandRequest = require('./UnderstandRequest');
const planRequest      = require('./PlanRequest');
const { discoverySearch } = require('./DiscoverySearch');

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
// DISCOVERY FIELDS
// ────────────────────────────────────────────────────────────────

const DISCOVERY_ORDER = [
    'status',
    'context',
    'discoveryContext',
    'totalFound',
    'summary',
    'companies',
    'results',
    'leads',
    'message',
];

const DISCOVERY_LABELS = {
    status:           { icon: '📶', label: 'Status' },
    context:          { icon: '🧩', label: 'Context' },
    discoveryContext: { icon: '🧩', label: 'Discovery Context' },
    totalFound:       { icon: '🔢', label: 'Total Found' },
    summary:          { icon: '📝', label: 'Summary' },
    companies:        { icon: '🏢', label: 'Companies' },
    results:          { icon: '📦', label: 'Results' },
    leads:            { icon: '🎁', label: 'Leads' },
    message:          { icon: '💬', label: 'Message' },
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

function renderAllocation(allocation) {
    if (!allocation || typeof allocation !== 'object') return null;

    const lines = [];

    if (allocation.totalSearches !== undefined && allocation.totalSearches !== null) {
        lines.push(`   • Total searches: ${allocation.totalSearches}`);
    }

    if (allocation.distribution && typeof allocation.distribution === 'object') {
        lines.push('   • Distribution:');
        for (const [key, value] of Object.entries(allocation.distribution)) {
            lines.push(`      – ${humanizeKey(key)}: ${value}`);
        }
    }

    const knownKeys = ['totalSearches', 'distribution'];
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
// RENDER: DISCOVERY
// ────────────────────────────────────────────────────────────────

function renderDiscovery(discovery) {
    if (!discovery || typeof discovery !== 'object') {
        return 'Discovery\n⚠️ No discovery data.';
    }

    const lines = [];

    for (const key of DISCOVERY_ORDER) {
        const value = discovery[key];
        if (value === undefined || value === null) continue;

        // ── Arrays of objects / strings ──
        if (Array.isArray(value)) {
            if (value.length === 0) continue;

            const meta = DISCOVERY_LABELS[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };
            lines.push(`${meta.icon} ${meta.label}:`);

            value.forEach((item, i) => {
                if (typeof item === 'string') {
                    lines.push(`   ${i + 1}. ${item}`);
                } else if (item && typeof item === 'object') {
                    const name = item.companyName || item.name || item.title || `Item ${i + 1}`;
                    lines.push(`   ${i + 1}. ${name}`);
                    for (const [k, v] of Object.entries(item)) {
                        if (k === 'companyName' || k === 'name' || k === 'title') continue;
                        if (v === undefined || v === null || v === '') continue;
                        lines.push(`      • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
                    }
                }
            });
            continue;
        }

        // ── Objects (context blocks, stats, etc.) ──
        if (typeof value === 'object') {
            const meta = DISCOVERY_LABELS[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };
            lines.push(`${meta.icon} ${meta.label}:`);
            for (const [k, v] of Object.entries(value)) {
                if (v === undefined || v === null || v === '') continue;
                lines.push(`   • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
            continue;
        }

        // ── Scalars ──
        const line = formatField(key, value, DISCOVERY_LABELS);
        if (line) lines.push(line);
    }

    // Extra fields
    const extras = Object.keys(discovery).filter(k => !DISCOVERY_ORDER.includes(k));
    for (const key of extras) {
        const line = formatField(key, discovery[key], DISCOVERY_LABELS);
        if (line) lines.push(line);
    }

    if (lines.length === 0) return 'Discovery\n⚠️ No discovery data.';
    return ['Discovery', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// COMPOSE FINAL REPLY — 3 SECTIONS
// ────────────────────────────────────────────────────────────────

function buildReply(understanding, plan, discovery) {
    const sections = [
        renderUnderstanding(understanding),
        renderPlanning(plan),
        renderDiscovery(discovery),
    ];

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

        // ── STEP 3: Discovery ──
        let discovery = null;
        try {
            discovery = await discoverySearch(understanding, plan, {
                message, history, userProfile, onProgress, options,
            });

            console.log('[Orchestrator] Discovery result:', discovery);
        } catch (discoveryErr) {
            console.error('[Orchestrator] DiscoverySearch failed:', discoveryErr.message);
            discovery = {
                status: 'error',
                message: discoveryErr.message,
            };
        }

        // ── STEP 4: Render all 3 sections ──
        const reply = buildReply(understanding, plan, discovery);
        console.log('[Orchestrator] Rendered reply:\n' + reply);

        return {
            reply,
            updatedHistory: history || [],
            meta: { understanding, plan, discovery },
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
