'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const axios = require('axios');
const Understanding = require('./Understanding');

// ────────────────────────────────────────────────────────────────
// 2. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);

        // ── Step 1: Understand the request ──
        const understanding = await Understanding.understand(message);
        console.log('📋 [FREE] Understanding result:', understanding);

        // ── Step 2: Build a user-friendly summary ──
        const summary = buildLeadSummary(understanding);
        console.log('📋 [FREE] Summary:', summary);

        // ── Step 3: Return the summary as a string ──
        return {
            reply: summary,  // ← Returns a STRING, not an object
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: message },
                { role: 'assistant', content: summary }
            ],
            _meta: {
                tier: 'free',
                understanding: understanding,
                status: understanding.status
            }
        };

    } catch (error) {
        console.error('❌ [FREE] Error:', error.message);
        return {
            reply: 'Sorry, something went wrong. Please try again.',
            updatedHistory: history || [],
            _meta: { error: error.message }
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 3. HELPER: Build User-Friendly Summary
// ────────────────────────────────────────────────────────────────

function buildLeadSummary(spec) {
    if (!spec || spec.status === 'invalid') {
        return '❌ I couldn\'t understand your request. Please try being more specific.';
    }

    if (spec.status === 'needs_clarification') {
        let msg = '⚠️ I need a bit more clarity:\n\n';
        if (spec.ambiguities && spec.ambiguities.length > 0) {
            spec.ambiguities.forEach(a => {
                msg += `• ${a.reason}\n`;
            });
        }
        msg += '\nCould you please provide more details?';
        return msg;
    }

    // ✅ Build a nice summary
    let summary = '📋 **Lead Request Summary**\n\n';

    // Target
    const targetType = spec.target?.type || 'company';
    const quantity = spec.target?.quantity ? ` up to ${spec.target.quantity}` : '';
    summary += `**Target:** ${targetType}${quantity}\n`;

    // Location
    if (spec.location) {
        const locations = [];
        if (spec.location.countries?.length) locations.push(`Countries: ${spec.location.countries.join(', ')}`);
        if (spec.location.cities?.length) locations.push(`Cities: ${spec.location.cities.join(', ')}`);
        if (spec.location.regions?.length) locations.push(`Regions: ${spec.location.regions.join(', ')}`);
        if (locations.length) summary += `**Location:** ${locations.join(' | ')}\n`;
    }

    // Company
    if (spec.company) {
        if (spec.company.industries?.length) summary += `**Industry:** ${spec.company.industries.join(', ')}\n`;
        if (spec.company.employeeRange) {
            const { min, max } = spec.company.employeeRange;
            summary += `**Company Size:** ${min || '0'} - ${max || 'Unlimited'} employees\n`;
        }
        if (spec.company.businessTypes?.length) summary += `**Business Type:** ${spec.company.businessTypes.join(', ')}\n`;
    }

    // Contact
    if (spec.contact) {
        if (spec.contact.required) summary += `**Contact Required:** Yes\n`;
        if (spec.contact.roles?.length) summary += `**Roles:** ${spec.contact.roles.join(', ')}\n`;
        if (spec.contact.intent) summary += `**Intent:** ${spec.contact.intent}\n`;
    }

    // Hard Requirements
    if (spec.hardRequirements?.length) {
        summary += `\n**🔒 Hard Requirements:**\n`;
        spec.hardRequirements.forEach(r => summary += `• ${r}\n`);
    }

    // Status
    summary += `\n**Status:** ✅ ${spec.status.toUpperCase()}`;

    return summary;
}

// ────────────────────────────────────────────────────────────────
// 4. EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
