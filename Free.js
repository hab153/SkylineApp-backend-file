'use strict';

const understandRequest    = require('./UnderstandRequest');
const planRequest         = require('./PlanRequest');
const summaryRequest      = require('./Summary');
const generationRequest   = require('./Generation');
const controllingRequest  = require('./Controlling');
const separationRequest   = require('./Separation');
const verificationRequest = require('./VerificationCompany');

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

// ────────────────────────────────────────────────────────────────
// GENERATION FIELDS
// ────────────────────────────────────────────────────────────────

const GENERATION_ORDER = [
    'searches',
    'allocation',
    'message',
];

const GENERATION_LABELS = {
    searches:   { icon: '🔎', label: 'Searches' },
    allocation: { icon: '📊', label: 'Allocation' },
    message:    { icon: '💬', label: 'Message' },
};

// ────────────────────────────────────────────────────────────────
// CONTROLLING FIELDS
// ────────────────────────────────────────────────────────────────

const CONTROLLING_ORDER = [
    'completed',
    'searchesProcessed',
    'reason',
];

const CONTROLLING_LABELS = {
    completed:         { icon: '✅', label: 'Completed' },
    searchesProcessed: { icon: '🔢', label: 'Searches Processed' },
    reason:            { icon: '💬', label: 'Reason' },
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

        if (key === 'allocation') {
            const block = renderAllocation(value);
            if (block) lines.push(block);
            continue;
        }

        if (Array.isArray(value)) {
            const items = value
                .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
                .filter(Boolean);
            if (items.length === 0) continue;
            lines.push(`${meta.icon} ${meta.label}:`);
            items.forEach((item, i) => lines.push(`   ${i + 1}. ${item}`));
            continue;
        }

        if (typeof value === 'object') {
            lines.push(`${meta.icon} ${meta.label}:`);
            for (const [k, v] of Object.entries(value)) {
                if (v === undefined || v === null || v === '') continue;
                lines.push(`   • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
            continue;
        }

        if (typeof value === 'string' && value.trim()) {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }
    }

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
// RENDER: GENERATION
// ────────────────────────────────────────────────────────────────

function renderGeneration(generation) {
    if (!generation || typeof generation !== 'object') {
        return 'Generation\n⚠️ No generation data.';
    }

    const lines = [];

    for (const key of GENERATION_ORDER) {
        const value = generation[key];
        if (value === undefined || value === null) continue;

        const meta = GENERATION_LABELS[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };

        if (key === 'allocation') {
            const block = renderAllocation(value);
            if (block) lines.push(block);
            continue;
        }

        if (Array.isArray(value)) {
            const items = value
                .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
                .filter(Boolean);
            if (items.length === 0) continue;
            lines.push(`${meta.icon} ${meta.label}:`);
            items.forEach((item, i) => lines.push(`   ${i + 1}. ${item}`));
            continue;
        }

        if (typeof value === 'object') {
            lines.push(`${meta.icon} ${meta.label}:`);
            for (const [k, v] of Object.entries(value)) {
                if (v === undefined || v === null || v === '') continue;
                lines.push(`   • ${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
            continue;
        }

        if (typeof value === 'string' && value.trim()) {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }
    }

    const extras = Object.keys(generation).filter(k => !GENERATION_ORDER.includes(k));
    for (const key of extras) {
        const value = generation[key];
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

    if (lines.length === 0) return 'Generation\n⚠️ No generation data.';
    return ['Generation', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// RENDER: CONTROLLING
// ────────────────────────────────────────────────────────────────

function renderControlling(controlling) {
    if (!controlling || typeof controlling !== 'object') {
        return 'Controlling\n⚠️ No controlling data.';
    }

    const lines = [];

    for (const key of CONTROLLING_ORDER) {
        const value = controlling[key];
        if (value === undefined || value === null) continue;

        const meta = CONTROLLING_LABELS[key] || { icon: DEFAULT_FIELD_ICON, label: titleCase(key) };

        if (typeof value === 'string' && value.trim()) {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }

        if (typeof value === 'boolean' || typeof value === 'number') {
            lines.push(`${meta.icon} ${meta.label}: ${value}`);
            continue;
        }
    }

    const extras = Object.keys(controlling).filter(k => !CONTROLLING_ORDER.includes(k));
    for (const key of extras) {
        const value = controlling[key];
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

    if (lines.length === 0) return 'Controlling\n⚠️ No controlling data.';
    return ['Controlling', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// RENDER: SEPARATION
// ────────────────────────────────────────────────────────────────

function renderSeparation(separation) {
    if (!separation || typeof separation !== 'object') {
        return 'Separation\n⚠️ No separation data.';
    }

    const lines = [];

    const collected = separation.collected;
    const totalResults = separation.totalResults;
    const companies = Array.isArray(separation.companies) ? separation.companies : [];

    if (
        collected !== undefined &&
        collected !== null &&
        !Number.isNaN(collected)
    ) {
        lines.push(`📦 Collected: ${collected} result sets`);
    }

    if (
        totalResults !== undefined &&
        totalResults !== null &&
        !Number.isNaN(totalResults)
    ) {
        lines.push(`🔢 Total results: ${totalResults}`);
    }

    lines.push(`🏢 Companies: ${companies.length}`);

    if (companies.length === 0) {
        if (separation.results !== undefined) {
            const v = separation.results;
            lines.push(
                `📝 Results: ${
                    typeof v === 'object'
                        ? JSON.stringify(v)
                        : v
                }`
            );
        }
    }

    if (companies.length > 0) {
        lines.push('');
        lines.push('──────────────────────────────────');
        lines.push('');

        companies.forEach((company, i) => {
            if (!company || typeof company !== 'object') return;

            const name =
                typeof company.name === 'string' && company.name.trim()
                    ? company.name.trim()
                    : `Company ${i + 1}`;

            lines.push(`Company ${i + 1}. ${name}`);

            const mentions = Array.isArray(company.mentions)
                ? company.mentions
                : [];

            mentions.forEach((mention, j) => {
                if (!mention || typeof mention !== 'object') return;

                const searchText =
                    typeof mention.search === 'string' && mention.search.trim()
                        ? mention.search.trim()
                        : null;

                const url =
                    typeof mention.url === 'string' && mention.url.trim()
                        ? mention.url.trim()
                        : null;

                const title =
                    typeof mention.title === 'string' && mention.title.trim()
                        ? mention.title.trim()
                        : null;

                const description =
                    typeof mention.description === 'string' &&
                    mention.description.trim()
                        ? mention.description.trim()
                        : null;

                const score =
                    typeof mention.score === 'number' ? mention.score : null;

                if (searchText) {
                    lines.push(`   🔍 Found in search: ${searchText}`);
                }

                if (url) {
                    lines.push(`   🔗 URL: ${url}`);
                }

                if (title) {
                    lines.push(`   📝 Title: ${title}`);
                }

                if (description) {
                    lines.push(`   📄 Description: ${description}`);
                }

                if (score !== null) {
                    lines.push(`   ⭐ Score: ${score}`);
                }

                if (j < mentions.length - 1) {
                    lines.push('   ───');
                }
            });

            if (i < companies.length - 1) {
                lines.push('');
            }
        });
    }

    const knownKeys = ['collected', 'totalResults', 'companies', 'results'];
    for (const key of Object.keys(separation)) {
        if (knownKeys.includes(key)) continue;
        const v = separation[key];
        if (v === undefined || v === null || v === '') continue;
        lines.push(`📝 ${humanizeKey(key)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }

    if (lines.length === 0) return 'Separation\n⚠️ No separation data.';
    return ['Separation', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// RENDER: VERIFICATION
// ────────────────────────────────────────────────────────────────

function renderVerification(verification) {
    if (!verification || typeof verification !== 'object') {
        return 'Verification\n⚠️ No verification data.';
    }

    if (typeof verification.message === 'string' && verification.message.trim()) {
        return ['Verification', `💬 Message: ${verification.message.trim()}`].join('\n');
    }

    const lines = [];

    const summary = verification.summary;
    if (summary && typeof summary === 'object') {
        const parts = [];
        if (typeof summary.valid === 'number') parts.push(`${summary.valid} valid`);
        if (typeof summary.invalid === 'number') parts.push(`${summary.invalid} invalid`);
        if (typeof summary.total === 'number') parts.push(`${summary.total} total`);
        if (parts.length > 0) {
            lines.push(`📊 Summary: ${parts.join(' / ')}`);
        }

        if (typeof summary.qualified === 'number') {
            lines.push(`✅ Qualified (rating 5+): ${summary.qualified}`);
        }
    }

    const qualified = Array.isArray(verification.qualified)
        ? verification.qualified
        : [];

    if (qualified.length > 0) {
        lines.push('');
        lines.push('──────────────────────────────────');
        lines.push('');
        lines.push('QUALIFIED COMPANIES');
        lines.push('');

        qualified.forEach((company, i) => {
            if (!company || typeof company !== 'object') return;

            const name =
                typeof company.name === 'string' && company.name.trim()
                    ? company.name.trim()
                    : `Company ${i + 1}`;

            lines.push(`Qualified Company ${i + 1}. ${name}`);

            const rating =
                typeof company.rating === 'number' ? company.rating : null;

            const status =
                typeof company.status === 'string' && company.status.trim()
                    ? company.status.trim()
                    : null;

            const reason =
                typeof company.reason === 'string' && company.reason.trim()
                    ? company.reason.trim()
                    : null;

            if (rating !== null) {
                lines.push(`   ⭐ Rating: ${rating}`);
            }

            if (status !== null) {
                lines.push(`   🏷️ Status: ${status}`);
            }

            if (reason !== null) {
                lines.push(`   💬 Reason: ${reason}`);
            }

            const mentions = Array.isArray(company.mentions) ? company.mentions : [];

            mentions.forEach((mention, j) => {
                if (!mention || typeof mention !== 'object') return;

                const searchText =
                    typeof mention.search === 'string' && mention.search.trim()
                        ? mention.search.trim()
                        : null;

                const url =
                    typeof mention.url === 'string' && mention.url.trim()
                        ? mention.url.trim()
                        : null;

                const title =
                    typeof mention.title === 'string' && mention.title.trim()
                        ? mention.title.trim()
                        : null;

                const description =
                    typeof mention.description === 'string' &&
                    mention.description.trim()
                        ? mention.description.trim()
                        : null;

                if (searchText) {
                    lines.push(`   🔍 Found in search: ${searchText}`);
                }

                if (url) {
                    lines.push(`   🔗 URL: ${url}`);
                }

                if (title) {
                    lines.push(`   📝 Title: ${title}`);
                }

                if (description) {
                    lines.push(`   📄 Description: ${description}`);
                }

                if (j < mentions.length - 1) {
                    lines.push('   ───');
                }
            });

            if (i < qualified.length - 1) {
                lines.push('');
            }
        });
    }

    const knownKeys = ['message', 'summary', 'verified', 'qualified'];
    for (const key of Object.keys(verification)) {
        if (knownKeys.includes(key)) continue;
        const v = verification[key];
        if (v === undefined || v === null || v === '') continue;
        lines.push(`📝 ${humanizeKey(key)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }

    if (lines.length === 0) return 'Verification\n⚠️ No verification data.';
    return ['Verification', ...lines].join('\n');
}

// ────────────────────────────────────────────────────────────────
// COMPOSE FINAL REPLY — 7 SECTIONS
// ────────────────────────────────────────────────────────────────

function buildReply(
    understanding,
    plan,
    summary,
    generation,
    controlling,
    separation,
    verification
) {
    const sections = [
        renderUnderstanding(understanding),
        renderPlanning(plan),
    ];

    if (summary) {
        sections.push(renderSummary(summary));
    }

    if (generation) {
        sections.push(renderGeneration(generation));
    }

    if (controlling) {
        sections.push(renderControlling(controlling));
    }

    if (separation) {
        sections.push(renderSeparation(separation));
    }

    if (verification) {
        sections.push(renderVerification(verification));
    }

    return sections.join('\n\n');
}

// ────────────────────────────────────────────────────────────────
// STAGE FUNCTIONS — one per pipeline stage
// ────────────────────────────────────────────────────────────────

// Stage 1 — Understanding
async function generateUnderstanding(message, options = {}) {
    console.log('[Orchestrator] Stage 1: Understanding');

    const understanding = await understandRequest(message, options);

    console.log('[Orchestrator] Understanding result:', understanding);

    return understanding;
}

// Stage 2 — Planning
async function generatePlanning(understanding, message, options = {}) {
    console.log('[Orchestrator] Stage 2: Planning');

    const plan = await planRequest(understanding, {
        message,
        ...options,
    });

    console.log('[Orchestrator] Plan result:', plan);

    return plan;
}

// Stage 3 — Summary
async function generateSummary(understanding, plan, options = {}) {
    console.log('[Orchestrator] Stage 3: Summary');

    try {
        const summary = await summaryRequest(understanding, plan, options);

        console.log('[Orchestrator] Summary result:', summary);

        return summary;
    } catch (summaryErr) {
        console.error('[Orchestrator] SummaryRequest failed:', summaryErr.message);

        return {
            summary: '',
            allocation: plan && plan.allocation ? plan.allocation : null,
        };
    }
}

// Stage 4 — Generation
async function generateGeneration(summary, options = {}) {
    console.log('[Orchestrator] Stage 4: Generation');

    try {
        const generation = await generationRequest(summary, options);

        console.log('[Orchestrator] Generation result:', generation);

        return generation;
    } catch (generationErr) {
        console.error('[Orchestrator] GenerationRequest failed:', generationErr.message);

        return {
            message: 'Our server is currently experiencing high traffic. Please try again shortly.',
        };
    }
}

// Stage 5 — Controlling
//
// The onProgress callback is forwarded to Controlling.js so the caller
// can receive per-search progress in real time:
//
//   onProgress(searchesProcessed, totalSearches)
//
// The callback is optional. When present, it lets the caller report
// live progress for the Search System phase.

async function generateControlling(generation, options = {}) {
    console.log('[Orchestrator] Stage 5: Controlling');

    try {
        const controlling = await controllingRequest(generation, options);

        console.log('[Orchestrator] Controlling result:', controlling);

        return controlling;
    } catch (controllingErr) {
        console.error('[Orchestrator] ControllingRequest failed:', controllingErr.message);

        return {
            completed: false,
            searchesProcessed: 0,
            reason: controllingErr.message,
        };
    }
}

// Stage 6 — Separation
async function generateSeparation(controlling, options = {}) {
    console.log('[Orchestrator] Stage 6: Separation');

    try {
        const separation = await separationRequest(controlling, options);

        console.log('[Orchestrator] Separation result:', separation);

        return separation;
    } catch (separationErr) {
        console.error('[Orchestrator] SeparationRequest failed:', separationErr.message);

        return {
            collected: 0,
            totalResults: 0,
            companies: [],
        };
    }
}

// Stage 7 — Verification
async function generateVerification(separation, understanding, options = {}) {
    console.log('[Orchestrator] Stage 7: Verification');

    try {
        const verification = await verificationRequest(separation, understanding, options);

        console.log('[Orchestrator] Verification result:', verification);

        return verification;
    } catch (verificationErr) {
        console.error('[Orchestrator] VerificationRequest failed:', verificationErr.message);

        return {
            message: 'Our server is currently experiencing high traffic. Please try again shortly.',
        };
    }
}

// ────────────────────────────────────────────────────────────────
// ORCHESTRATOR — full pipeline (unchanged, for backward compatibility)
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress, options = {}) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    try {
        const understanding = await generateUnderstanding(message, {
            history, userProfile, onProgress, options,
        });

        const plan = await generatePlanning(understanding, message, {
            history, userProfile, onProgress, options,
        });

        const summary = await generateSummary(understanding, plan, {
            message, history, userProfile, onProgress, options,
        });

        const generation = await generateGeneration(summary, {
            message, history, userProfile, onProgress, options,
        });

        const controlling = await generateControlling(generation, {
            message, history, userProfile, onProgress, options,
        });

        const separation = await generateSeparation(controlling, {
            message, history, userProfile, onProgress, options,
        });

        const verification = await generateVerification(separation, understanding, {
            message, history, userProfile, onProgress, options,
        });

        const reply = buildReply(
            understanding,
            plan,
            summary,
            generation,
            controlling,
            separation,
            verification
        );
        console.log('[Orchestrator] Rendered reply:\n' + reply);

        return {
            reply,
            updatedHistory: history || [],
            meta: {
                understanding,
                plan,
                summary,
                generation,
                controlling,
                separation,
                verification,
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

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
    generateUnderstanding,
    generatePlanning,
    generateSummary,
    generateGeneration,
    generateControlling,
    generateSeparation,
    generateVerification,
    buildReply,
};
