'use strict';

// ─── ARCHITECTURE SCORING TABLE ───────────────────────────────────────────────
// Source: Lead Intelligence Architecture doc — exact points, no deviation

const PERSONALIZATION_SCORE = {
    founderIdentified: +25,
    personalEmail:     +25,
    exactDomainMatch:  +15,
    mxVerified:        +10,
    publiclyVisible:   +10,
    teamPageSource:    +10,
    genericInbox:      -30,
    fallbackGuess:     -40,
    directorySource:   -50,
};

// Final confidence thresholds
const CONFIDENCE_LEVELS = {
    HIGH:   { min: 90, max: 100, label: 'Highly reliable' },
    GOOD:   { min: 70, max: 89,  label: 'Good lead'       },
    WEAK:   { min: 50, max: 69,  label: 'Weak'            },
    REJECT: { min: 0,  max: 49,  label: 'Reject'          },
};

// ─── ROLE PRIORITY TABLE ──────────────────────────────────────────────────────
const ROLE_PRIORITY_TABLE = {
    'founder':           100,
    'ceo':               100,
    'co-founder':         95,
    'cofounder':          95,
    'head of growth':     90,
    'owner':              88,
    'sales director':     85,
    'marketing director': 80,
    'marketing lead':     80,
    'vp':                 75,
    'director':           70,
    'manager':            60,
    'generic inbox':      40,
};

function getRolePriority(role) {
    if (!role) return 0;
    const r = role.toLowerCase();
    for (const [key, val] of Object.entries(ROLE_PRIORITY_TABLE)) {
        if (r.includes(key)) return val;
    }
    return 40;
}

function getConfidenceLabel(score) {
    for (const level of Object.values(CONFIDENCE_LEVELS)) {
        if (score >= level.min && score <= level.max) return level.label;
    }
    return 'Reject';
}

// ─── MAIN SCORING ENGINE ──────────────────────────────────────────────────────
function scoreLeadQuality({
    emailType,
    mxValid,
    sourcePage,
    bestContact,
    companyData,
    dataScore,
}) {
    let score = 0;
    const signals = [];

    // ── Founder/CEO identified ────────────────────────────────────────────────
    const rolePriority = getRolePriority(bestContact?.role);
    if (rolePriority >= 95) {
        score += PERSONALIZATION_SCORE.founderIdentified;
        signals.push(`+25 Founder/CEO identified (${bestContact?.role})`);
    }

    // ── Email type scoring ────────────────────────────────────────────────────
    if (emailType === 'confirmed-personal' || emailType === 'regex-real' || emailType === 'hunted-real') {
        score += PERSONALIZATION_SCORE.personalEmail;
        signals.push('+25 Personal/real email found');
    } else if (emailType === 'pattern-generated') {
        score += PERSONALIZATION_SCORE.fallbackGuess;
        signals.push('-40 Pattern-generated (not verified)');
    } else if (emailType === 'confirmed-generic') {
        score += PERSONALIZATION_SCORE.genericInbox;
        signals.push('-30 Generic inbox');
    }

    // ── Domain match ──────────────────────────────────────────────────────────
    if (emailType !== 'unrelated-domain' && emailType !== 'none') {
        score += PERSONALIZATION_SCORE.exactDomainMatch;
        signals.push('+15 Exact domain match');
    }

    // ── MX verified ───────────────────────────────────────────────────────────
    if (mxValid) {
        score += PERSONALIZATION_SCORE.mxVerified;
        signals.push('+10 MX verified');
    }

    // ── Publicly visible ──────────────────────────────────────────────────────
    if (emailType === 'regex-real' || emailType === 'hunted-real') {
        score += PERSONALIZATION_SCORE.publiclyVisible;
        signals.push('+10 Publicly visible email');
    }

    // ── Team/about page source ────────────────────────────────────────────────
    const goodSources = ['team','about','contact','leadership'];
    if (sourcePage && goodSources.some(s => sourcePage.toLowerCase().includes(s))) {
        score += PERSONALIZATION_SCORE.teamPageSource;
        signals.push(`+10 Team/about page source (${sourcePage})`);
    }

    // ── Directory source penalty ──────────────────────────────────────────────
    if (sourcePage && ['directory','database','scraped'].some(s => sourcePage.toLowerCase().includes(s))) {
        score += PERSONALIZATION_SCORE.directorySource;
        signals.push('-50 Directory source');
    }

    const finalScore = Math.max(0, Math.min(100, score));
    return {
        leadScore:        finalScore,
        confidenceLabel:  getConfidenceLabel(finalScore),
        confidenceSignals:signals,
        shouldReject:     finalScore < 50,
    };
}

// ─── LEAD ACCEPTANCE GATE ─────────────────────────────────────────────────────
// Architecture rule: below 50 = reject. Never return junk leads.
function shouldAcceptLead(scoringResult, emailResolution) {
    if (scoringResult.shouldReject) {
        console.log(`🚫 [SCORE GATE] Lead rejected — score ${scoringResult.leadScore}/100`);
        return false;
    }
    if (!emailResolution) {
        console.log(`🚫 [SCORE GATE] Lead rejected — no reliable email`);
        return false;
    }
    if (emailResolution.verification === 'pattern-generated' && scoringResult.leadScore < 70) {
        console.log(`🚫 [SCORE GATE] Pattern-generated email with low score — rejected`);
        return false;
    }
    return true;
}

module.exports = {
    scoreLeadQuality,
    shouldAcceptLead,
    getRolePriority,
    getConfidenceLabel,
    CONFIDENCE_LEVELS,
};
