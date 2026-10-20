// ────────────────────────────────────────────────────────────────
// Free.js — Orchestrator (fires all stage events)
// ────────────────────────────────────────────────────────────────
'use strict';

const seekerRequest = require('./Seeker');
const finderRequest = require('./Finder');
const contactPagesRequest = require('./ContactPages');
const searchingRequest = require('./Searching');

// ────────────────────────────────────────────────────────────────
// STAGE IDs
// ────────────────────────────────────────────────────────────────

const STAGE_IDS = {
    UNDERSTANDING:  's1',
    DISCOVERY:      's2',
    DOMAIN:         's3',
    CONTACT_PAGES:  's4',
    COMPANY_DATA:   's5',
    DONE:           'done',
    ERROR:          'error',
};

// ────────────────────────────────────────────────────────────────
// FORMAT REPLY
// ────────────────────────────────────────────────────────────────

// Reads from Searching's output — { companies: [...] }.
// Renders exactly 4 labeled fields per company, nothing else.

function formatReply(searchingOutput) {
    if (
        searchingOutput &&
        typeof searchingOutput.message === 'string' &&
        searchingOutput.message.trim().length > 0
    ) {
        return `💬 ${searchingOutput.message}`;
    }

    const companies = Array.isArray(searchingOutput?.companies)
        ? searchingOutput.companies
        : [];

    if (companies.length === 0) {
        return '⚠️ No company data was returned.';
    }

    const blocks = [];

    for (let i = 0; i < companies.length; i++) {
        const c = companies[i] || {};

        const name =
            typeof c.companyName === 'string' && c.companyName.trim()
                ? c.companyName.trim()
                : `Company ${i + 1}`;

        // ── Email ──
        let emailDisplay = 'Not found';
        if (c.email) {
            if (c.emailStatus === 'predicted') {
                emailDisplay = `${c.email} (predicted — not verified)`;
            } else {
                emailDisplay = c.email;
            }
        }

        // ── Company information ──
        let infoDisplay = 'Not available';
        if (typeof c.companyInformation === 'string' && c.companyInformation.trim()) {
            infoDisplay =
                c.informationStatus === 'estimated'
                    ? `${c.companyInformation.trim()} (AI estimate)`
                    : c.companyInformation.trim();
        }

        // ── Phone ──
        const phoneDisplay =
            typeof c.phoneNumber === 'string' && c.phoneNumber.trim()
                ? c.phoneNumber.trim()
                : 'Not found';

        const block = [
            `**Company ${i + 1}**`,
            '',
            `Company name: ${name}`,
            `Company email: ${emailDisplay}`,
            `Company phone number: ${phoneDisplay}`,
            `Company information: ${infoDisplay}`,
        ].join('\n');

        blocks.push(block);
    }

    return blocks.join('\n\n');
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

    const emit = typeof onStage === 'function' ? onStage : () => {};

    try {
        // ── s1 — Understanding ──
        emit(STAGE_IDS.UNDERSTANDING, { status: 'processing' });

        let seekerOutput = null;

        try {
            seekerOutput = await seekerRequest(message);
        } catch (err) {
            console.error('[Orchestrator] Seeker failed:', err?.message || err);
            seekerOutput = { message: 'Our server is currently experiencing high traffic. Please try again shortly.' };
        }

        emit(STAGE_IDS.UNDERSTANDING, { status: 'completed', data: { message } });

        // ── s2 — Discovery ──
        emit(STAGE_IDS.DISCOVERY, { status: 'processing' });
        emit(STAGE_IDS.DISCOVERY, {
            status: 'completed',
            data: {
                searches: Array.isArray(seekerOutput?.searches) ? seekerOutput.searches : [],
                results: Array.isArray(seekerOutput?.results) ? seekerOutput.results : [],
            },
        });

        // ── s3 — Domain Finder ──
        emit(STAGE_IDS.DOMAIN, { status: 'processing' });

        let finderOutput = null;

        try {
            finderOutput = await finderRequest(seekerOutput, message);
        } catch (err) {
            console.error('[Orchestrator] Finder failed:', err?.message || err);
            finderOutput = { message: 'Our server is currently experiencing high traffic. Please try again shortly.' };
        }

        emit(STAGE_IDS.DOMAIN, {
            status: 'completed',
            data: {
                companies: Array.isArray(finderOutput?.companies) ? finderOutput.companies : [],
                message: typeof finderOutput?.message === 'string' ? finderOutput.message : null,
            },
        });

        // ── s4 — Contact Pages ──
        emit(STAGE_IDS.CONTACT_PAGES, { status: 'processing' });

        let contactPagesOutput = null;

        try {
            contactPagesOutput = await contactPagesRequest(finderOutput);
        } catch (err) {
            console.error('[Orchestrator] ContactPages failed:', err?.message || err);
            contactPagesOutput = { message: 'Our server is currently experiencing high traffic. Please try again shortly.' };
        }

        emit(STAGE_IDS.CONTACT_PAGES, {
            status: 'completed',
            data: {
                pages: Array.isArray(contactPagesOutput?.pages) ? contactPagesOutput.pages : [],
                message: typeof contactPagesOutput?.message === 'string' ? contactPagesOutput.message : null,
            },
        });

        // ── s5 — Company Data ──
        emit(STAGE_IDS.COMPANY_DATA, { status: 'processing' });

        let searchingOutput = null;

        try {
            searchingOutput = await searchingRequest(contactPagesOutput);
        } catch (err) {
            console.error('[Orchestrator] Searching failed:', err?.message || err);
            searchingOutput = { message: 'Our server is currently experiencing high traffic. Please try again shortly.' };
        }

        emit(STAGE_IDS.COMPANY_DATA, {
            status: 'completed',
            data: {
                companies: Array.isArray(searchingOutput?.companies) ? searchingOutput.companies : [],
                message: typeof searchingOutput?.message === 'string' ? searchingOutput.message : null,
            },
        });

        // ── Build reply + meta ──
        const reply = formatReply(searchingOutput);

        const meta =
            searchingOutput && Array.isArray(searchingOutput.companies)
                ? { companies: searchingOutput.companies }
                : { companies: [] };

        emit(STAGE_IDS.DONE, { completed: true });

        console.log('[Orchestrator] Final result ready');

        return { reply, meta };
    } catch (error) {
        console.error('[Orchestrator] Request failed:', error?.message || error);

        emit(STAGE_IDS.ERROR, {
            message: error?.message || 'Pipeline failed',
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
