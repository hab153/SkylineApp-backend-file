// ──────────────────────────────────────────────────────────────
// PLANNING.JS — Layer 2: Search Planning Engine
// 
// RESPONSIBILITIES:
// - Validate Layer 1 contract
// - Build search objective
// - Generate search hypotheses
// - Create source strategy
// - Define evidence requirements
// - Preserve hard/soft/excluded requirements
// - NEVER change what the user requested
// - Output validated search plan
// ──────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');

// ──────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ──────────────────────────────────────────────────────────────

const CONFIG = {
    DISCOVERY_MULTIPLIER: 1.5,      // Requested × 1.5 = discovery target
    MAX_HYPOTHESES_PER_BRANCH: 5,    // Max search approaches per industry
    MIN_HYPOTHESES_PER_BRANCH: 2,    // Min search approaches per industry
    SOURCES: {
        companyDiscovery: ['tavily', 'apollo'],
        contactDiscovery: ['linkedin', 'apollo'],
        verification: ['company_website', 'linkedin']
    },
    EVIDENCE: {
        company: ['company_identity', 'industry', 'location'],
        contact: ['person_identity', 'company_association', 'requested_role']
    }
};

// ──────────────────────────────────────────────────────────────
// 2. SEARCH PLAN CONTRACT
// ──────────────────────────────────────────────────────────────

/**
 * The Search Plan is the single source of truth for HOW to find leads.
 * Layer 3 (Discovery) will execute this plan.
 */
const SEARCH_PLAN_SCHEMA = {
    planVersion: 'string',
    requestId: 'string',
    objective: {
        targetType: 'company | contact | both',
        role: 'string | null',
        industries: ['string'],
        location: {
            city: 'string | null',
            region: 'string | null',
            country: 'string | null',
            countryCode: 'string | null'
        },
        companySize: {
            value: 'string | null',
            restricted: 'boolean'
        },
        companyAge: {
            value: 'string | null',
            restricted: 'boolean'
        },
        funding: {
            value: 'string | null',
            restricted: 'boolean'
        },
        businessTypes: ['string'],
        technologies: ['string']
    },
    quantity: {
        requested: 'number | null',
        discoveryTarget: 'number | null'
    },
    searchBranches: [
        {
            industry: 'string',
            hypotheses: ['string'],
            priority: 'number'
        }
    ],
    sourceStrategy: [
        {
            type: 'search_engine' | 'company_website' | 'professional_profile' | 'api',
            purpose: 'company_discovery' | 'company_verification' | 'contact_discovery' | 'contact_verification',
            sources: ['string']
        }
    ],
    evidenceRequirements: {
        company: ['string'],
        contact: ['string'],
        additional: ['string']
    },
    contactStrategy: {
        required: 'boolean',
        role: 'string | null',
        verificationRequired: 'boolean'
    },
    requirements: {
        hard: ['string'],
        soft: ['string'],
        excluded: ['string']
    },
    deduplication: {
        required: 'boolean',
        primaryKeys: ['string']
    },
    status: 'ready' | 'needs_clarification' | 'invalid',
    createdBy: 'Planning.js',
    createdAt: 'string',
    version: 'string'
};

// ──────────────────────────────────────────────────────────────
// 3. VALIDATION — Layer 1 Contract
// ──────────────────────────────────────────────────────────────

function validateLayer1Contract(contract) {
    const errors = [];

    // ── Check status ──
    if (!contract || contract.status === 'invalid') {
        errors.push('Layer 1 contract is invalid');
    }
    if (contract.status === 'needs_clarification') {
        errors.push('Layer 1 needs clarification — cannot plan search');
    }

    // ── Check required fields ──
    if (!contract.target || !contract.target.type) {
        errors.push('Target type is missing');
    }
    if (!['company', 'contact', 'both'].includes(contract.target?.type)) {
        errors.push(`Invalid target type: ${contract.target?.type}`);
    }

    // ── Check location ──
    if (!contract.location) {
        errors.push('Location is missing');
    }

    // ── Check industry ──
    if (!contract.company || !contract.company.industry || contract.company.industry.length === 0) {
        errors.push('Industry is missing');
    }

    // ── Check quantity ──
    if (contract.target?.quantity !== null && contract.target?.quantity !== undefined) {
        if (typeof contract.target.quantity !== 'number' || contract.target.quantity < 1) {
            errors.push(`Invalid quantity: ${contract.target.quantity}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

// ──────────────────────────────────────────────────────────────
// 4. BUILD SEARCH OBJECTIVE
// ──────────────────────────────────────────────────────────────

function buildObjective(contract) {
    return {
        targetType: contract.target?.type || 'company',
        role: contract.target?.role || null,
        industries: contract.company?.industry || [],
        location: {
            city: contract.location?.city || null,
            region: contract.location?.region || null,
            country: contract.location?.country || null,
            countryCode: contract.location?.countryCode || null
        },
        companySize: {
            value: contract.company?.size?.value || null,
            restricted: contract.company?.size?.restricted || false
        },
        companyAge: {
            value: contract.company?.age?.value || null,
            restricted: contract.company?.age?.restricted || false
        },
        funding: {
            value: contract.company?.funding?.value || null,
            restricted: contract.company?.funding?.restricted || false
        },
        businessTypes: contract.company?.businessType || [],
        technologies: contract.company?.technologies || []
    };
}

// ──────────────────────────────────────────────────────────────
// 5. GENERATE SEARCH HYPOTHESES
// ──────────────────────────────────────────────────────────────

function generateHypotheses(industry, objective) {
    const hypotheses = [];
    const role = objective.role || 'decision maker';
    const location = objective.location.city || objective.location.country || '';
    const targetType = objective.targetType;

    // ── Base hypothesis ──
    if (targetType === 'contact') {
        hypotheses.push(`${industry} companies ${location} ${role}`);
        hypotheses.push(`${role}s of ${industry} companies in ${location}`);
        hypotheses.push(`${industry} ${location} ${role} contact`);
    } else {
        hypotheses.push(`${industry} companies ${location}`);
        hypotheses.push(`${industry} ${location} business`);
    }

    // ── Variations ──
    if (industry.includes('SaaS')) {
        hypotheses.push(`SaaS ${location} ${role}`);
        hypotheses.push(`Software companies ${location} ${role}`);
        if (targetType === 'contact') {
            hypotheses.push(`Founders of SaaS companies ${location}`);
        }
    }

    if (industry.includes('Real Estate') || industry.includes('Property')) {
        hypotheses.push(`Real estate ${location} ${role}`);
        hypotheses.push(`Property ${location} companies ${role}`);
        if (targetType === 'contact') {
            hypotheses.push(`Real estate founders ${location}`);
        }
    }

    if (industry.includes('Fintech') || industry.includes('Financial Technology')) {
        hypotheses.push(`Fintech ${location} ${role}`);
        hypotheses.push(`Financial technology ${location} ${role}`);
    }

    if (industry.includes('AI') || industry.includes('Artificial Intelligence')) {
        hypotheses.push(`AI companies ${location} ${role}`);
        hypotheses.push(`Artificial intelligence ${location} ${role}`);
    }

    if (industry.includes('Cybersecurity') || industry.includes('Cyber Security')) {
        hypotheses.push(`Cybersecurity ${location} ${role}`);
        hypotheses.push(`Security ${location} companies ${role}`);
    }

    // ── Add location-specific variations ──
    if (location) {
        hypotheses.push(`${industry} in ${location}`);
        hypotheses.push(`${location} ${industry} ${targetType === 'contact' ? role : 'companies'}`);
    }

    // ── Add "startup" variation if not restricted ──
    if (!objective.companyAge?.restricted) {
        hypotheses.push(`${industry} startups ${location}`);
        if (targetType === 'contact') {
            hypotheses.push(`${industry} startup founders ${location}`);
        }
    }

    // ── Add "B2B" variation ──
    if (!objective.businessTypes.includes('B2C')) {
        hypotheses.push(`B2B ${industry} ${location}`);
    }

    // ── Remove duplicates and trim ──
    const unique = [...new Set(hypotheses)];
    const trimmed = unique.filter(h => h.trim().length > 0);

    // ── Limit to max hypotheses ──
    const maxCount = Math.max(CONFIG.MIN_HYPOTHESES_PER_BRANCH, Math.min(trimmed.length, CONFIG.MAX_HYPOTHESES_PER_BRANCH));

    return trimmed.slice(0, maxCount);
}

// ──────────────────────────────────────────────────────────────
// 6. BUILD SEARCH BRANCHES
// ──────────────────────────────────────────────────────────────

function buildSearchBranches(objective) {
    const branches = [];
    const industries = objective.industries || [];

    if (industries.length === 0) {
        // If no industry specified, use a default
        branches.push({
            industry: 'business',
            hypotheses: generateHypotheses('business', objective),
            priority: 1
        });
        return branches;
    }

    industries.forEach((industry, index) => {
        branches.push({
            industry: industry,
            hypotheses: generateHypotheses(industry, objective),
            priority: index + 1
        });
    });

    return branches;
}

// ──────────────────────────────────────────────────────────────
// 7. BUILD SOURCE STRATEGY
// ──────────────────────────────────────────────────────────────

function buildSourceStrategy(objective) {
    const strategy = [];

    // ── Company Discovery ──
    strategy.push({
        type: 'search_engine',
        purpose: 'company_discovery',
        sources: CONFIG.SOURCES.companyDiscovery
    });

    // ── Company Verification ──
    strategy.push({
        type: 'company_website',
        purpose: 'company_verification',
        sources: CONFIG.SOURCES.verification
    });

    // ── Contact Discovery ──
    if (objective.targetType === 'contact' || objective.targetType === 'both') {
        strategy.push({
            type: 'professional_profile',
            purpose: 'contact_discovery',
            sources: CONFIG.SOURCES.contactDiscovery
        });
    }

    // ── Contact Verification ──
    if (objective.targetType === 'contact' || objective.targetType === 'both') {
        strategy.push({
            type: 'professional_profile',
            purpose: 'contact_verification',
            sources: ['linkedin']
        });
    }

    return strategy;
}

// ──────────────────────────────────────────────────────────────
// 8. BUILD EVIDENCE REQUIREMENTS
// ──────────────────────────────────────────────────────────────

function buildEvidenceRequirements(objective) {
    const requirements = {
        company: [...CONFIG.EVIDENCE.company],
        contact: [],
        additional: []
    };

    // ── Add contact evidence ──
    if (objective.targetType === 'contact' || objective.targetType === 'both') {
        requirements.contact = [...CONFIG.EVIDENCE.contact];
        if (objective.role) {
            requirements.contact.push(`role_${objective.role.toLowerCase()}`);
        }
    }

    // ── Add company size if restricted ──
    if (objective.companySize.restricted && objective.companySize.value) {
        requirements.additional.push(`company_size_${objective.companySize.value}`);
    }

    // ── Add company age if restricted ──
    if (objective.companyAge.restricted && objective.companyAge.value) {
        requirements.additional.push(`company_age_${objective.companyAge.value}`);
    }

    // ── Add funding if restricted ──
    if (objective.funding.restricted && objective.funding.value) {
        requirements.additional.push(`funding_${objective.funding.value}`);
    }

    // ── Add technologies if specified ──
    if (objective.technologies && objective.technologies.length > 0) {
        requirements.additional.push(`technologies_${objective.technologies.join('_')}`);
    }

    // ── Add business types if specified ──
    if (objective.businessTypes && objective.businessTypes.length > 0) {
        requirements.additional.push(`business_type_${objective.businessTypes.join('_')}`);
    }

    return requirements;
}

// ──────────────────────────────────────────────────────────────
// 9. BUILD CONTACT STRATEGY
// ──────────────────────────────────────────────────────────────

function buildContactStrategy(objective) {
    return {
        required: objective.targetType === 'contact' || objective.targetType === 'both',
        role: objective.role || null,
        verificationRequired: objective.targetType === 'contact' || objective.targetType === 'both'
    };
}

// ──────────────────────────────────────────────────────────────
// 10. BUILD DEDUPLICATION STRATEGY
// ──────────────────────────────────────────────────────────────

function buildDeduplicationStrategy() {
    return {
        required: true,
        primaryKeys: ['normalized_domain', 'company_name']
    };
}

// ──────────────────────────────────────────────────────────────
// 11. MAIN PLANNING FUNCTION
// ──────────────────────────────────────────────────────────────

/**
 * Create a search plan from a Layer 1 Understanding contract
 * 
 * @param {Object} contract - Layer 1 Understanding contract
 * @returns {Object} Validated Search Plan
 */
function plan(contract) {
    console.log('[PLANNING] Creating search plan...');

    // ── Step 1: Validate Layer 1 ──
    const validation = validateLayer1Contract(contract);
    if (!validation.valid) {
        console.error('[PLANNING] Validation failed:', validation.errors);
        return {
            status: 'invalid',
            errors: validation.errors,
            requestId: contract?.requestId || `plan-${uuidv4().substring(0, 8)}`,
            createdAt: new Date().toISOString(),
            version: '1.0.0'
        };
    }

    console.log('[PLANNING] Layer 1 contract validated ✅');

    // ── Step 2: Build Objective ──
    const objective = buildObjective(contract);
    console.log('[PLANNING] Objective built:', JSON.stringify(objective, null, 2));

    // ── Step 3: Calculate Quantity ──
    const requested = contract.target?.quantity || null;
    const discoveryTarget = requested ? Math.ceil(requested * CONFIG.DISCOVERY_MULTIPLIER) : null;

    // ── Step 4: Build Search Branches ──
    const searchBranches = buildSearchBranches(objective);
    console.log(`[PLANNING] ${searchBranches.length} search branches created`);

    // ── Step 5: Build Source Strategy ──
    const sourceStrategy = buildSourceStrategy(objective);

    // ── Step 6: Build Evidence Requirements ──
    const evidenceRequirements = buildEvidenceRequirements(objective);

    // ── Step 7: Build Contact Strategy ──
    const contactStrategy = buildContactStrategy(objective);

    // ── Step 8: Build Deduplication Strategy ──
    const deduplication = buildDeduplicationStrategy();

    // ── Step 9: Build Requirements ──
    const requirements = {
        hard: contract.requirements?.hard || [],
        soft: contract.requirements?.soft || [],
        excluded: contract.requirements?.excluded || []
    };

    // ── Step 10: Assemble Plan ──
    const plan = {
        planVersion: '1.0.0',
        requestId: contract.requestId || `plan-${uuidv4().substring(0, 8)}`,
        objective: objective,
        quantity: {
            requested: requested,
            discoveryTarget: discoveryTarget
        },
        searchBranches: searchBranches,
        sourceStrategy: sourceStrategy,
        evidenceRequirements: evidenceRequirements,
        contactStrategy: contactStrategy,
        requirements: requirements,
        deduplication: deduplication,
        status: 'ready',
        createdBy: 'Planning.js',
        createdAt: new Date().toISOString(),
        version: '2.0.0'
    };

    // ── Step 11: Validate Plan ──
    const planValidation = validatePlan(plan);
    if (!planValidation.valid) {
        console.error('[PLANNING] Plan validation failed:', planValidation.errors);
        return {
            status: 'invalid',
            errors: planValidation.errors,
            requestId: contract.requestId,
            createdAt: new Date().toISOString(),
            version: '2.0.0'
        };
    }

    console.log('[PLANNING] Plan validated ✅');
    console.log(`[PLANNING] Plan created: ${plan.requestId}`);

    return plan;
}

// ──────────────────────────────────────────────────────────────
// 12. PLAN VALIDATION
// ──────────────────────────────────────────────────────────────

function validatePlan(plan) {
    const errors = [];

    // ── Check objective ──
    if (!plan.objective) {
        errors.push('Objective is missing');
    }
    if (!plan.objective.industries || plan.objective.industries.length === 0) {
        errors.push('No industries in objective');
    }

    // ── Check search branches ──
    if (!plan.searchBranches || plan.searchBranches.length === 0) {
        errors.push('No search branches created');
    } else {
        plan.searchBranches.forEach((branch, index) => {
            if (!branch.industry) {
                errors.push(`Branch ${index + 1}: missing industry`);
            }
            if (!branch.hypotheses || branch.hypotheses.length === 0) {
                errors.push(`Branch ${index + 1}: no hypotheses`);
            }
        });
    }

    // ── Check source strategy ──
    if (!plan.sourceStrategy || plan.sourceStrategy.length === 0) {
        errors.push('No source strategy defined');
    }

    // ── Check evidence requirements ──
    if (!plan.evidenceRequirements) {
        errors.push('No evidence requirements defined');
    }

    // ── Check contact strategy ──
    if (!plan.contactStrategy) {
        errors.push('No contact strategy defined');
    }

    // ── Check status ──
    if (!['ready', 'needs_clarification', 'invalid'].includes(plan.status)) {
        errors.push(`Invalid status: ${plan.status}`);
    }

    // ── Check quantity preservation ──
    if (plan.quantity.requested !== null && typeof plan.quantity.requested !== 'number') {
        errors.push('Requested quantity must be a number or null');
    }

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

// ──────────────────────────────────────────────────────────────
// 13. PUBLIC EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    // Main function
    plan,

    // Config
    CONFIG,

    // Contract Schema
    SEARCH_PLAN_SCHEMA,

    // Validation
    validateLayer1Contract,
    validatePlan,

    // Builders (for testing)
    buildObjective,
    buildSearchBranches,
    buildSourceStrategy,
    buildEvidenceRequirements,
    buildContactStrategy,
    buildDeduplicationStrategy,
    generateHypotheses
};
