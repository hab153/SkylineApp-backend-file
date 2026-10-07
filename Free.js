'use strict';

const understandRequest = require('./UnderstandRequest');
const planRequest      = require('./PlanRequest');
const { discoverySearch, searchTask } = require('./DiscoverySearch');

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

// ────────────────────────────────────────────────────────────────
// DISCOVERY CONTEXT INNER FIELD LABELS
// ────────────────────────────────────────────────────────────────

// Labels for the 17 fields inside the Discovery Context object.
// These reuse the Understanding and Planning icons so the Discovery section
// displays with the same visual style as the earlier sections.

const DISCOVERY_CONTEXT_LABELS = {
    target:              { icon: '🎯', label: 'Target' },
    need:                { icon: '📌', label: 'Need' },
    intent:              { icon: '💡', label: 'Intent' },
    location:            { icon: '📍', label: 'Location' },
    industry:            { icon: '🏭', label: 'Industry' },
    qualification:       { icon: '✅', label: 'Qualification' },
    signal:              { icon: '📡', label: 'Signal' },
    quantity:            { icon: '🔢', label: 'Quantity' },
    requiredInformation: { icon: '📋', label: 'Required Information' },
    exclusions:          { icon: '🚫', label: 'Exclusions' },
    constraints:         { icon: '📎', label: 'Constraints' },
    strategy:            { icon: '🧭', label: 'Strategy' },
    source:              { icon: '🔗', label: 'Source' },
    query:               { icon: '🔍', label: 'Query' },
    evidenceSearch:      { icon: '🔬', label: 'Evidence Search' },
    allocation:          { icon: '📊', label: 'Allocation' },
    searchExpansion:     { icon: '🌐', label: 'Search Expansion' },
};

const DISCOVERY_CONTEXT_ORDER = [
    'target',
    'need',
    'intent',
    'location',
    'industry',
    'qualification',
    'signal',
    'quantity',
    'requiredInformation',
    'exclusions',
    'constraints',
    'strategy',
    'source',
    'query',
    'evidenceSearch',
    'allocation',
    'searchExpansion',
];

// ────────────────────────────────────────────────────────────────
// TASK COORDINATION FIELD LABELS
// ────────────────────────────────────────────────────────────────

const TASK_ORDER = [
    'type',
    'objective',
    'queries',
    'sources',
    'requirements',
    'evidenceQueries',
    'evidenceRequirement',
    'exclusions',
    'constraints',
    'requestedQuantity',
];

const TASK_LABELS = {
    type:                { icon: '🎯', label: 'Type' },
    objective:           { icon: '🧭', label: 'Objective' },
    queries:             { icon: '🔍', label: 'Queries' },
    sources:             { icon: '🔗', label: 'Sources' },
    requirements:        { icon: '✅', label: 'Requirements' },
    evidenceQueries:     { icon: '🔬', label: 'Evidence Queries' },
    evidenceRequirement: { icon: '📡', label: 'Evidence Requirement' },
    exclusions:          { icon: '🚫', label: 'Exclusions' },
    constraints:         { icon: '📎', label: 'Constraints' },
    requestedQuantity:   { icon: '🔢', label: 'Requested Quantity' },
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
// RENDER: DISCOVERY CONTEXT BLOCK
// ────────────────────────────────────────────────────────────────

// Renders the discoveryContext object as a fully labeled block, using the
// DISCOVERY_CONTEXT_LABELS map so the icons and labels match the earlier
// Understanding and Planning sections.

function renderDiscoveryContext(context) {
    if (!context || typeof context !== 'object') return null;

    const lines = [];

    for (const key of DISCOVERY_CONTEXT_ORDER) {
        const value = context[key];
        if (value === undefined || value === null) continue;

        // Location — special rendering
        if (key === 'location') {
            const locLine = formatLocation(value);
            if (locLine) lines.push(locLine);
            continue;
        }

        const meta = DISCOVERY_CONTEXT_LABELS[key] || {
            icon: DEFAULT_FIELD_ICON,
            label: titleCase(key),
        };

        // Arrays — numbered list for query and evidenceSearch
        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            const items = value
                .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
                .filter(Boolean);
            if (items.length === 0) continue;

            if (key === 'query' || key === 'evidenceSearch' || key === 'requiredInformation') {
                lines.push(`${meta.icon} ${meta.label}:`);
                items.forEach((item, i) => lines.push(`   ${i + 1}. ${item}`));
                continue;
            }

            lines.push(`${meta.icon} ${meta.label}: ${items.join(', ')}`);
            continue;
        }

        // Allocation — use the allocation renderer
        if (key === 'allocation') {
            const block = renderAllocation(value);
            if (block) lines.push(block);
            continue;
        }

        // Other objects — generic rendering
        if (typeof value === 'object') {
            lines.push(`${meta.icon} ${meta.label}:`);
            for (const [k, v] of Object.entries(value)) {
                if (v === undefined || v === null || v === '') continue;
                lines.push(`   • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
            continue;
        }

        // Scalars
        if (typeof value === 'string' && value.trim()) {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }
    }

    // Extra fields not in the known order
    const extras = Object.keys(context).filter(k => !DISCOVERY_CONTEXT_ORDER.includes(k));
    for (const key of extras) {
        const value = context[key];
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

    if (lines.length === 0) return null;
    return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────
// RENDER: TASK COORDINATION
// ────────────────────────────────────────────────────────────────

// Renders a Search Task object as a fully labeled block using the
// TASK_LABELS map. Arrays (queries, evidenceQueries) are numbered.
// Empty strings and empty arrays are skipped.

function renderTaskCoordination(task) {
    if (!task || typeof task !== 'object') {
        return 'Task Coordination\n⚠️ No task data.';
    }

    const lines = [];

    for (const key of TASK_ORDER) {
        const value = task[key];
        if (value === undefined || value === null) continue;

        const meta = TASK_LABELS[key] || {
            icon: DEFAULT_FIELD_ICON,
            label: humanizeKey(key),
        };

        // Arrays
        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            const items = value
                .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
                .filter(Boolean);
            if (items.length === 0) continue;

            lines.push(`${meta.icon} ${meta.label}:`);
            items.forEach((item, i) => lines.push(`   ${i + 1}. ${item}`));
            continue;
        }

        // Objects — generic rendering
        if (typeof value === 'object') {
            lines.push(`${meta.icon} ${meta.label}:`);
            for (const [k, v] of Object.entries(value)) {
                if (v === undefined || v === null || v === '') continue;
                lines.push(`   • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
            continue;
        }

        // Scalars — skip empty strings
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
    const extras = Object.keys(task).filter(k => !TASK_ORDER.includes(k));
    for (const key of extras) {
        const value = task[key];
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

    if (lines.length === 0) return 'Task Coordination\n⚠️ No task data.';
    return ['Task Coordination', ...lines].join('\n');
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

    // If the discovery object itself is the discovery context — meaning it
    // has the context shape (target, need, intent, ...) — render it directly
    // with the context renderer.
    if (
        discovery.target !== undefined &&
        discovery.need !== undefined &&
        discovery.intent !== undefined
    ) {
        const block = renderDiscoveryContext(discovery);
        if (block) return ['Discovery', block].join('\n');
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

            // If this is the discovery context, use its dedicated renderer.
            if (key === 'discoveryContext' || key === 'context') {
                const block = renderDiscoveryContext(value);
                if (block) {
                    // Indent each line of the context block
                    for (const line of block.split('\n')) {
                        lines.push(`   ${line}`);
                    }
                }
                continue;
            }

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
// COMPOSE FINAL REPLY — 4 SECTIONS
// ────────────────────────────────────────────────────────────────

function buildReply(understanding, plan, discovery, task) {
    const sections = [
        renderUnderstanding(understanding),
        renderPlanning(plan),
        renderDiscovery(discovery),
    ];

    if (task) {
        sections.push(renderTaskCoordination(task));
    }

    return sections.join('\n\n');
}

// ────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress, options = {}) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    // The stage to build the search task for.
    // Until Discovery Control exists, this defaults to 'companyDiscovery'.
    // Callers can override via options.currentStage.
    const currentStage = options.currentStage || 'companyDiscovery';

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

        // ── STEP 3: Discovery Context ──
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

        // ── STEP 4: Task Coordination ──
        let task = null;
        if (discovery && !discovery.status) {
            try {
                task = await searchTask(discovery, currentStage);

                console.log('[Orchestrator] Task result:', task);
            } catch (taskErr) {
                console.error('[Orchestrator] SearchTask failed:', taskErr.message);
                task = {
                    type: currentStage,
                    objective: 'Task Coordination failed',
                    queries: [],
                    sources: '',
                    requirements: '',
                    evidenceQueries: [],
                    evidenceRequirement: '',
                    exclusions: '',
                    constraints: '',
                    requestedQuantity: '',
                };
            }
        }

        // ── STEP 5: Render all sections ──
        const reply = buildReply(understanding, plan, discovery, task);
        console.log('[Orchestrator] Rendered reply:\n' + reply);

        return {
            reply,
            updatedHistory: history || [],
            meta: { understanding, plan, discovery, task },
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
