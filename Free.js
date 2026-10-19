// ────────────────────────────────────────────────────────────────
// Free.js — Orchestrator
// ────────────────────────────────────────────────────────────────
'use strict';

const seekerRequest = require('./Seeker');
const finderRequest = require('./Finder');

// ────────────────────────────────────────────────────────────────
// FORMAT REPLY
// ────────────────────────────────────────────────────────────────

// Builds a human-readable reply from Finder's output.
// Only Finder's output is shown — Seeker's raw results are not exposed.

function formatReply(finderOutput) {
    // ── Fallback message ──
    if (
        finderOutput &&
        typeof finderOutput.message === 'string' &&
        finderOutput.message.trim().length > 0
    ) {
        return `💬 ${finderOutput.message}`;
    }

    const companies = Array.isArray(finderOutput?.companies)
        ? finderOutput.companies
        : [];

    if (companies.length === 0) {
        return '⚠️ No company results were returned.';
    }

    const lines = [];

    lines.push('**🏢 COMPANIES DISCOVERED**');
    lines.push('');

    for (let i = 0; i < companies.length; i++) {
        const c = companies[i];
        const name = c?.name || `Company ${i + 1}`;
        const query = c?.query || '';
        const tavilyResults = Array.isArray(c?.results?.results)
            ? c.results.results
            : [];

        lines.push(`**${i + 1}. ${name}**`);
        if (query) lines.push(`🔎 Query: ${query}`);
        lines.push(`📄 ${tavilyResults.length} result(s)`);

        const top = tavilyResults.slice(0, 5);
        for (const item of top) {
            const title = item?.title ? item.title.trim() : null;
            const url = item?.url ? item.url.trim() : null;

            if (title) lines.push(`• ${title}`);
            if (url) lines.push(`  🔗 ${url}`);
        }

        if (tavilyResults.length > 5) {
            lines.push(`… and ${tavilyResults.length - 5} more`);
        }

        lines.push('');
    }

    return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

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
        // ── STEP 1: Seeker ──
        let seekerOutput = null;

        try {
            seekerOutput = await seekerRequest(message);
            console.log('[Orchestrator] Seeker output:', seekerOutput);
        } catch (seekerErr) {
            console.error(
                '[Orchestrator] Seeker failed:',
                seekerErr && seekerErr.message
                    ? seekerErr.message
                    : seekerErr
            );

            seekerOutput = {
                message:
                    'Our server is currently experiencing high traffic. Please try again shortly.',
            };
        }

        // ── STEP 2: Finder ──
        let finderOutput = null;

        try {
            finderOutput = await finderRequest(seekerOutput, message);
            console.log('[Orchestrator] Finder output:', finderOutput);
        } catch (finderErr) {
            console.error(
                '[Orchestrator] Finder failed:',
                finderErr && finderErr.message
                    ? finderErr.message
                    : finderErr
            );

            finderOutput = {
                message:
                    'Our server is currently experiencing high traffic. Please try again shortly.',
            };
        }

        // ── STEP 3: Build reply from Finder's output ──
        const reply = formatReply(finderOutput);

        // ── STEP 4: Build meta — only Finder's output ──
        const meta =
            finderOutput && Array.isArray(finderOutput.companies)
                ? {
                      companies: finderOutput.companies,
                  }
                : {
                      companies: [],
                  };

        console.log('[Orchestrator] Final result ready');

        return {
            reply,
            meta,
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
};
