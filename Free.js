'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const axios = require('axios');
const Understanding = require('./Understanding');
const Planning = require('./Planning');

// ────────────────────────────────────────────────────────────────
// 2. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);

        // ── Step 1: Understand the request ──
        const understanding = await Understanding.understand(message);
        console.log('📋 [FREE] Understanding result:', JSON.stringify(understanding, null, 2));

        // ── Step 2: Plan the search ──
        const plan = await Planning.plan(understanding);
        console.log('📋 [FREE] Planning result:', JSON.stringify(plan, null, 2));

        // ── Step 3: Build a user-friendly summary ──
        const summary = buildLeadSummary(understanding, plan);
        console.log('📋 [FREE] Summary:', summary);

        // ── Step 4: Return the summary as a string ──
        return {
            reply: summary,
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: message },
                { role: 'assistant', content: summary }
            ],
            _meta: {
                tier: 'free',
                understanding: understanding,
                plan: plan,
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
// 3. HELPER: Build User-Friendly Summary — COMPLETE VERSION
// ────────────────────────────────────────────────────────────────

function buildLeadSummary(spec, plan) {
    if (!spec || spec.status === 'invalid') {
        return '❌ I couldn\'t understand your request. Please try being more specific.';
    }

    if (spec.status === 'needs_clarification') {
        let msg = '⚠️ I need a bit more clarity:\n\n';
        if (spec.ambiguities && spec.ambiguities.length > 0) {
            spec.ambiguities.forEach(a => {
                msg += `• ${a.reason}\n`;
                if (a.clarification_question) {
                    msg += `  → ${a.clarification_question}\n`;
                }
            });
        }
        msg += '\nCould you please provide more details?';
        return msg;
    }

    // ✅ Build a complete summary
    let summary = '📋 **Lead Request Summary**\n\n';

    // ── Target ──
    const targetType = spec.target?.type || 'Unknown';
    const role = spec.target?.role ? ` (${spec.target.role})` : '';
    const quantity = spec.target?.quantity ? ` up to ${spec.target.quantity}` : '';
    summary += `**Target:** ${targetType}${role}${quantity}\n`;

    // ── Location ──
    if (spec.location) {
        const locations = [];
        if (spec.location.country) locations.push(`Country: ${spec.location.country}`);
        if (spec.location.city) locations.push(`City: ${spec.location.city}`);
        if (spec.location.region) locations.push(`Region: ${spec.location.region}`);
        if (spec.location.countryCode) locations.push(`Code: ${spec.location.countryCode}`);
        if (locations.length) {
            summary += `**Location:** ${locations.join(' | ')}\n`;
        }
    }

    // ── Company ──
    if (spec.company) {
        if (spec.company.industry && spec.company.industry.length > 0) {
            summary += `**Industry:** ${spec.company.industry.join(', ')}\n`;
        }
        if (spec.company.size && spec.company.size.value) {
            const restricted = spec.company.size.restricted ? ' (specified)' : ' (any)';
            summary += `**Company Size:** ${spec.company.size.value}${restricted}\n`;
        }
        if (spec.company.businessType && spec.company.businessType.length > 0) {
            summary += `**Business Type:** ${spec.company.businessType.join(', ')}\n`;
        }
        if (spec.company.technologies && spec.company.technologies.length > 0) {
            summary += `**Technologies:** ${spec.company.technologies.join(', ')}\n`;
        }
        if (spec.company.age && spec.company.age.value) {
            const restricted = spec.company.age.restricted ? ' (specified)' : ' (any)';
            summary += `**Company Age:** ${spec.company.age.value}${restricted}\n`;
        }
        if (spec.company.funding && spec.company.funding.value) {
            const restricted = spec.company.funding.restricted ? ' (specified)' : ' (any)';
            summary += `**Funding:** ${spec.company.funding.value}${restricted}\n`;
        }
    }

    // ── Contact ──
    if (spec.contact_required) {
        summary += `**Contact Required:** ✅ Yes\n`;
    } else {
        summary += `**Contact Required:** ❌ No (company only)\n`;
    }

    // ── Hard Requirements ──
    if (spec.requirements && spec.requirements.hard && spec.requirements.hard.length > 0) {
        summary += `\n**🔒 Requirements:**\n`;
        spec.requirements.hard.forEach(r => summary += `• ${r}\n`);
    }

    // ── Soft Requirements (Preferences) ──
    if (spec.requirements && spec.requirements.soft && spec.requirements.soft.length > 0) {
        summary += `\n**💡 Preferences:**\n`;
        spec.requirements.soft.forEach(r => summary += `• ${r}\n`);
    }

    // ── Exclusions ──
    if (spec.requirements && spec.requirements.excluded && spec.requirements.excluded.length > 0) {
        summary += `\n**🚫 Excluded:**\n`;
        spec.requirements.excluded.forEach(r => summary += `• ${r}\n`);
    }

    // ── Confidence ──
    if (spec.interpretation && spec.interpretation.confidence !== undefined) {
        const confidencePercent = Math.round(spec.interpretation.confidence * 100);
        summary += `\n**Confidence:** ${confidencePercent}%`;
    }

    // ── Assumptions (Normalizations) ──
    if (spec.interpretation && spec.interpretation.assumptions && spec.interpretation.assumptions.length > 0) {
        summary += `\n**🔧 Normalized:**\n`;
        spec.interpretation.assumptions.forEach(a => {
            summary += `• ${a.input} → ${a.interpretedAs} (${a.reason})\n`;
        });
    }

    // ── Ambiguities ──
    if (spec.ambiguities && spec.ambiguities.length > 0) {
        summary += `\n**⚠️ Ambiguities:**\n`;
        spec.ambiguities.forEach(a => {
            summary += `• ${a.reason}\n`;
            if (a.clarification_question) {
                summary += `  → ${a.clarification_question}\n`;
            }
        });
    }

    // ── Contradictions ──
    if (spec.contradictions && spec.contradictions.length > 0) {
        summary += `\n**❌ Contradictions:**\n`;
        spec.contradictions.forEach(c => {
            summary += `• ${c.reason}\n`;
            if (c.suggestion) {
                summary += `  → ${c.suggestion}\n`;
            }
        });
    }

    // ── Search Plan ──
    if (plan) {
        summary += `\n**🔍 Search Plan:**\n`;
        if (plan.sources && plan.sources.length > 0) {
            summary += `• Sources: ${plan.sources.join(', ')}\n`;
        }
        if (plan.queries && plan.queries.length > 0) {
            summary += `• Queries:\n`;
            plan.queries.forEach(q => {
                summary += `  - ${q}\n`;
            });
        }
        if (plan.strategy) {
            summary += `• Strategy: ${plan.strategy}\n`;
        }
        if (plan.estimatedLeads) {
            summary += `• Estimated Leads: ${plan.estimatedLeads}\n`;
        }
    }

    // ── Status ──
    const statusEmoji = spec.status === 'ready' ? '✅' : spec.status === 'needs_clarification' ? '⚠️' : '❌';
    summary += `\n**Status:** ${statusEmoji} ${spec.status.toUpperCase()}`;

    // ── Request ID ──
    if (spec.requestId) {
        summary += `\n**Request ID:** \`${spec.requestId}\``;
    }

    // ── Version ──
    if (spec.version) {
        summary += `\n**Version:** ${spec.version}`;
    }

    return summary;
}

// ────────────────────────────────────────────────────────────────
// 4. EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
