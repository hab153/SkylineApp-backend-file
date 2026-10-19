// ────────────────────────────────────────────────────────────────
// Free.js — Orchestrator (fires all stage events)
// ────────────────────────────────────────────────────────────────
'use strict';

const seekerRequest = require('./Seeker');
const finderRequest = require('./Finder');
const contactPagesRequest = require('./ContactPages');

// ────────────────────────────────────────────────────────────────
// STAGE IDs
// ────────────────────────────────────────────────────────────────

const STAGE_IDS = {
    UNDERSTANDING: 's1',
    DISCOVERY:     's2',
    DOMAIN:        's3',
    CONTACT_PAGES: 's4',
    DONE:          'done',
    ERROR:         'error',
};

// ────────────────────────────────────────────────────────────────
// FORMAT REPLY
// ────────────────────────────────────────────────────────────────

function formatReply(contactPagesOutput) {
    if (
        contactPagesOutput &&
        typeof contactPagesOutput.message === 'string' &&
        contactPagesOutput.message.trim().length > 0
    ) {
        return `💬 ${contactPagesOutput.message}`;
    }

    const pages = Array.isArray(contactPagesOutput?.pages)
        ? contactPagesOutput.pages
        : [];

    if (pages.length === 0) {
        return '⚠️ No company page results were returned.';
    }

    const lines = [];

    lines.push('**🏢 COMPANY PAGES DISCOVERED**');
    lines.push('');

    for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const name = p?.name || `Company ${i + 1}`;
        const domain = p?.domain || '';
        const urls = Array.isArray(p?.mapResponse?.results)
            ? p.mapResponse.results
            : [];

        lines.push(`**${i + 1}. ${name}**`);
        if (domain) lines.push(`🌐 Domain: ${domain}`);
        lines.push(`🔗 ${urls.length} page URL(s) found`);
        lines.push('');

        for (let u = 0; u < urls.length; u++) {
            const url = urls[u];
            if (typeof url === 'string' && url.trim().length > 0) {
                lines.push(`  • ${url.trim()}`);
            }
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
    options = {},
    onStage = () => {}
) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    // ── Ensure onStage is callable ──
    const emit = typeof onStage === 'function' ? onStage : () => {};

    try {
        // ── s1 — Understanding (processing) ──
        emit(STAGE_IDS.UNDERSTANDING, { status: 'processing' });

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

        // ── s1 completed + s2 processing — Seeker returned ──
        emit(STAGE_IDS.UNDERSTANDING, {
            status: 'completed',
            data: { message },
        });

        emit(STAGE_IDS.DISCOVERY, { status: 'processing' });

        emit(STAGE_IDS.DISCOVERY, {
            status: 'completed',
            data: {
                searches: Array.isArray(seekerOutput?.searches)
                    ? seekerOutput.searches
                    : [],
                results: Array.isArray(seekerOutput?.results)
                    ? seekerOutput.results
                    : [],
            },
        });

        // ── s3 — Domain (Finder) ──
        emit(STAGE_IDS.DOMAIN, { status: 'processing' });

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

        // ── s3 completed ──
        emit(STAGE_IDS.DOMAIN, {
            status: 'completed',
            data: {
                companies: Array.isArray(finderOutput?.companies)
                    ? finderOutput.companies
                    : [],
                message:
                    typeof finderOutput?.message === 'string'
                        ? finderOutput.message
                        : null,
            },
        });

        // ── s4 — Contact Pages ──
        emit(STAGE_IDS.CONTACT_PAGES, { status: 'processing' });

        // ── STEP 3: ContactPages ──
        let contactPagesOutput = null;

        try {
            contactPagesOutput = await contactPagesRequest(finderOutput);
            console.log(
                '[Orchestrator] ContactPages output:',
                contactPagesOutput
            );
        } catch (contactPagesErr) {
            console.error(
                '[Orchestrator] ContactPages failed:',
                contactPagesErr && contactPagesErr.message
                    ? contactPagesErr.message
                    : contactPagesErr
            );

            contactPagesOutput = {
                message:
                    'Our server is currently experiencing high traffic. Please try again shortly.',
            };
        }

        // ── s4 completed ──
        emit(STAGE_IDS.CONTACT_PAGES, {
            status: 'completed',
            data: {
                pages: Array.isArray(contactPagesOutput?.pages)
                    ? contactPagesOutput.pages
                    : [],
                message:
                    typeof contactPagesOutput?.message === 'string'
                        ? contactPagesOutput.message
                        : null,
            },
        });

        // ── STEP 4: Build reply ──
        const reply = formatReply(contactPagesOutput);

        // ── STEP 5: Build meta — ContactPages only ──
        const meta =
            contactPagesOutput && Array.isArray(contactPagesOutput.pages)
                ? { pages: contactPagesOutput.pages }
                : { pages: [] };

        // ── Done ──
        emit(STAGE_IDS.DONE, { completed: true });

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

        // ── Fire error event ──
        emit(STAGE_IDS.ERROR, {
            message:
                error && error.message
                    ? error.message
                    : 'Pipeline failed',
        });

        throw error;
    }
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
    STAGE_IDS,
};
