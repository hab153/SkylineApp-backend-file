// ────────────────────────────────────────────────────────────────
// Free.js — Orchestrator
// ────────────────────────────────────────────────────────────────
'use strict';

const seekerRequest = require('./Seeker');

// ────────────────────────────────────────────────────────────────
// FORMAT REPLY
// ────────────────────────────────────────────────────────────────

// Builds a human-readable reply from Seeker's output.
// The meta object is returned alongside so the frontend can use
// the raw data programmatically if it needs to.

function formatReply(seekerOutput) {
    // ── Fallback message — Seeker failed entirely ──
    if (
        seekerOutput &&
        typeof seekerOutput.message === 'string' &&
        seekerOutput.message.trim().length > 0
    ) {
        return `💬 ${seekerOutput.message}`;
    }

    const searches = Array.isArray(seekerOutput?.searches)
        ? seekerOutput.searches
        : [];

    const results = Array.isArray(seekerOutput?.results)
        ? seekerOutput.results
        : [];

    const lines = [];

    // ── Searches generated ──
    if (searches.length > 0) {
        lines.push('**🔎 SEARCHES GENERATED**');
        lines.push('');
        for (let i = 0; i < searches.length; i++) {
            lines.push(`${i + 1}. ${searches[i]}`);
        }
        lines.push('');
    }

    // ── Results per search ──
    if (results.length > 0) {
        let totalResults = 0;
        for (const entry of results) {
            if (entry?.response?.results && Array.isArray(entry.response.results)) {
                totalResults += entry.response.results.length;
            }
        }

        lines.push('---');
        lines.push('');
        lines.push('**📦 SEARCH RESULTS**');
        lines.push('');
        lines.push(
            `📊 ${results.length} search(es) returned ${totalResults} result(s)`
        );
        lines.push('');

        for (let s = 0; s < results.length; s++) {
            const entry = results[s];
            const query = entry.search || `Search ${s + 1}`;
            const items = Array.isArray(entry?.response?.results)
                ? entry.response.results
                : [];

            lines.push(`**${s + 1}. ${query}**`);
            lines.push(`📄 ${items.length} result(s)`);

            const top = items.slice(0, 5);
            for (const item of top) {
                const title = item?.title ? item.title.trim() : null;
                const url = item?.url ? item.url.trim() : null;

                if (title) lines.push(`• ${title}`);
                if (url) lines.push(`  🔗 ${url}`);
            }

            if (items.length > 5) {
                lines.push(`… and ${items.length - 5} more`);
            }

            lines.push('');
        }
    } else {
        lines.push('');
        lines.push('⚠️ No search results were returned.');
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
        // ── STEP 1: Call Seeker ──
        let seekerOutput = null;

        try {
            seekerOutput = await seekerRequest(message);
            console.log('[Orchestrator] Seeker output:', seekerOutput);
        } catch (seekerErr) {
            console.error(
                '[Orchestrator] Seeker failed:',
                seekerErr && seekerErr.message ? seekerErr.message : seekerErr
            );

            seekerOutput = {
                message:
                    'Our server is currently experiencing high traffic. Please try again shortly.',
            };
        }

        // ── STEP 2: Build reply ──
        const reply = formatReply(seekerOutput);

        // ── STEP 3: Build meta ──
        const meta =
            seekerOutput && Array.isArray(seekerOutput.searches)
                ? {
                      searches: seekerOutput.searches,
                      results: Array.isArray(seekerOutput.results)
                          ? seekerOutput.results
                          : [],
                  }
                : {
                      searches: [],
                      results: [],
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
