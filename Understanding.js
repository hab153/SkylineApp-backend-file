// ──────────────────────────────────────────────────────────────
// UNDERSTANDING.JS — Lead Request Understanding Engine
// Layer 1: Convert human intent → precise, validated contract
// 
// RESPONSIBILITIES:
// - Interpret natural language
// - Normalize terminology
// - Separate hard/soft/excluded requirements
// - Detect genuine ambiguity
// - Detect contradictions
// - NEVER invent requirements
// - Output clean, predictable, validated contract
// ──────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

// ──────────────────────────────────────────────────────────────
// 1. OUTPUT CONTRACT — The exact shape Layer 2 expects
// ──────────────────────────────────────────────────────────────

/**
 * The Understanding contract is the single source of truth
 * for what the user actually requested.
 * 
 * Important: "Not specified" means null/empty, NOT a default.
 * Defaults belong in Search Planning, NOT Understanding.
 */
const CONTRACT_SCHEMA = {
  target: {
    type: 'company' | 'contact' | 'both' | null,  // What to find
    role: 'string | null',                        // Specific role if contact
    quantity: 'number | null'                     // How many (null = as many as possible)
  },
  company: {
    industry: ['string'],                         // What they do
    size: {
      value: 'string | null',                     // "any", "small", "medium", "large", "enterprise"
      restricted: 'boolean'                       // true = user specified, false = not specified
    },
    age: {
      value: 'string | null',                     // "any", "startup", "established"
      restricted: 'boolean'
    },
    funding: {
      value: 'string | null',                     // "any", "bootstrapped", "seed", "series_a", etc.
      restricted: 'boolean'
    },
    businessType: ['string'],                     // B2B, B2C, agency, enterprise, etc.
    technologies: ['string']                      // Stack they use
  },
  location: {
    city: 'string | null',
    region: 'string | null',
    country: 'string | null',                     // Normalized to full country name
    countryCode: 'string | null',                 // ISO 2-letter code
    restrictions: {
      type: 'include' | 'exclude' | null,
      value: 'string | null'
    }
  },
  requirements: {
    hard: ['string'],                             // MUST have — non-negotiable
    soft: ['string'],                             // Nice to have — preferences
    excluded: ['string']                          // MUST NOT have
  },
  contact_required: 'boolean',                    // true = needs a person, false = company only
  interpretation: {
    confidence: 'number',                         // 0.0 - 1.0
    assumptions: [
      {
        type: 'normalization' | 'inference' | 'default',
        input: 'string',
        interpretedAs: 'string',
        reason: 'string'
      }
    ]
  },
  status: 'ready' | 'needs_clarification' | 'invalid',
  ambiguities: [
    {
      field: 'string',
      reason: 'string',
      clarification_question: 'string | null'
    }
  ],
  contradictions: [
    {
      field: 'string',
      reason: 'string',
      suggestion: 'string | null'
    }
  ],
  originalRequest: 'string',
  requestId: 'string',
  processedAt: 'string',
  version: 'string'
};

// ──────────────────────────────────────────────────────────────
// 2. NORMALIZATION MAPPINGS
// ──────────────────────────────────────────────────────────────

// Country normalization — full names → ISO codes
const COUNTRY_TO_CODE = {
  'germany': 'DE',
  'german': 'DE',
  'deutschland': 'DE',
  'france': 'FR',
  'french': 'FR',
  'united kingdom': 'GB',
  'uk': 'GB',
  'britain': 'GB',
  'england': 'GB',
  'nigeria': 'NG',
  'usa': 'US',
  'united states': 'US',
  'america': 'US',
  'canada': 'CA',
  'australia': 'AU',
  'india': 'IN',
  'china': 'CN',
  'japan': 'JP',
  'singapore': 'SG',
  'spain': 'ES',
  'italy': 'IT',
  'netherlands': 'NL',
  'sweden': 'SE',
  'norway': 'NO',
  'denmark': 'DK',
  'finland': 'FI',
  'ireland': 'IE',
  'south africa': 'ZA',
  'brazil': 'BR',
  'mexico': 'MX'
};

// Code → Full name (for display)
const CODE_TO_COUNTRY = {
  'DE': 'Germany',
  'FR': 'France',
  'GB': 'United Kingdom',
  'NG': 'Nigeria',
  'US': 'United States',
  'CA': 'Canada',
  'AU': 'Australia',
  'IN': 'India',
  'CN': 'China',
  'JP': 'Japan',
  'SG': 'Singapore',
  'ES': 'Spain',
  'IT': 'Italy',
  'NL': 'Netherlands',
  'SE': 'Sweden',
  'NO': 'Norway',
  'DK': 'Denmark',
  'FI': 'Finland',
  'IE': 'Ireland',
  'ZA': 'South Africa',
  'BR': 'Brazil',
  'MX': 'Mexico'
};

// Industry normalization
const INDUSTRY_MAPPINGS = {
  'saas': 'SaaS',
  'software as a service': 'SaaS',
  'cybersecurity': 'Cybersecurity',
  'cyber security': 'Cybersecurity',
  'fintech': 'Fintech',
  'financial technology': 'Fintech',
  'healthcare': 'Healthcare',
  'health care': 'Healthcare',
  'manufacturing': 'Manufacturing',
  'e-commerce': 'E-commerce',
  'ecommerce': 'E-commerce',
  'retail': 'Retail',
  'logistics': 'Logistics',
  'ai': 'AI',
  'artificial intelligence': 'AI',
  'machine learning': 'Machine Learning',
  'ml': 'Machine Learning',
  'blockchain': 'Blockchain',
  'real estate': 'Real Estate',
  'education': 'Education',
  'edtech': 'EdTech',
  'hr': 'HR',
  'human resources': 'HR',
  'marketing': 'Marketing',
  'adtech': 'AdTech',
  'insurance': 'Insurance',
  'insurtech': 'InsurTech',
  'legal': 'Legal',
  'legaltech': 'LegalTech',
  'energy': 'Energy',
  'cleantech': 'CleanTech',
  'agriculture': 'Agriculture',
  'agritech': 'AgriTech'
};

// Role normalization
const ROLE_MAPPINGS = {
  'ceo': 'CEO',
  'chief executive officer': 'CEO',
  'chief exec': 'CEO',
  'founder': 'Founder',
  'co-founder': 'Co-Founder',
  'cofounder': 'Co-Founder',
  'cto': 'CTO',
  'chief technology officer': 'CTO',
  'cfo': 'CFO',
  'chief financial officer': 'CFO',
  'ciso': 'CISO',
  'chief information security officer': 'CISO',
  'cmo': 'CMO',
  'chief marketing officer': 'CMO',
  'coo': 'COO',
  'chief operating officer': 'COO',
  'vp': 'VP',
  'vice president': 'VP',
  'director': 'Director',
  'head': 'Head',
  'manager': 'Manager',
  'owner': 'Owner',
  'president': 'President',
  'executive': 'Executive',
  'decision maker': 'Decision Maker',
  'decision-maker': 'Decision Maker'
};

// Company size normalization
const SIZE_MAPPINGS = {
  'any': 'any',
  'small': 'small',
  'medium': 'medium',
  'large': 'large',
  'enterprise': 'enterprise',
  'startup': 'startup',
  'sme': 'sme',
  'solo': 'solo',
  'freelancer': 'solo'
};

const SIZE_TO_RANGE = {
  'solo': { min: 1, max: 1 },
  'small': { min: 2, max: 50 },
  'medium': { min: 51, max: 200 },
  'sme': { min: 2, max: 200 },
  'large': { min: 201, max: 1000 },
  'enterprise': { min: 1001, max: null },
  'startup': { min: 2, max: 100 },
  'any': { min: null, max: null }
};

// ──────────────────────────────────────────────────────────────
// 3. AMBIGUITY DETECTION — Rule-Based, Not AI
// ──────────────────────────────────────────────────────────────

/**
 * Detect ambiguities in the request.
 * 
 * IMPORTANT: Only flag TRUE ambiguities — things that could
 * mean multiple different things. Do NOT flag unspecified
 * information as ambiguous.
 * 
 * Example TRUE ambiguity: "technology" could mean SaaS, hardware, AI, etc.
 * Example NOT ambiguous: missing company size — that's just unspecified.
 */
function detectAmbiguities(originalRequest, parsed) {
  const ambiguities = [];
  const lower = originalRequest.toLowerCase();

  // ── Industry ambiguity ──
  if (lower.includes('technology') && !lower.includes('saas') && !lower.includes('software')) {
    ambiguities.push({
      field: 'company.industry',
      reason: '"Technology" is a broad category. Could mean SaaS, hardware, AI, cybersecurity, or IT services.',
      clarification_question: 'What type of technology companies are you looking for? (e.g., SaaS, AI, cybersecurity, hardware, IT services)'
    });
  }

  if (lower.includes('tech') && !lower.includes('saas') && !lower.includes('software')) {
    ambiguities.push({
      field: 'company.industry',
      reason: '"Tech" is ambiguous. Could mean software, hardware, or other technology sectors.',
      clarification_question: 'What specific technology sector? (e.g., SaaS, AI, cybersecurity, fintech)'
    });
  }

  if (lower.includes('business') && !lower.includes('saas') && !lower.includes('software')) {
    ambiguities.push({
      field: 'company.industry',
      reason: '"Business" is too broad. Could refer to any industry.',
      clarification_question: 'What industry are you targeting?'
    });
  }

  // ── "need" ambiguity ──
  if (/\bneed(s|ed)?\b/i.test(lower) && !lower.includes('leads') && !lower.includes('find')) {
    ambiguities.push({
      field: 'intent',
      reason: 'The word "need" is ambiguous without context. Are you looking for leads, security, hiring, or something else?',
      clarification_question: 'What exactly are you looking for? (e.g., leads, contacts, company information)'
    });
  }

  // ── Contact vs Company ambiguity ──
  if (!lower.includes('ceo') && !lower.includes('founder') && !lower.includes('contact') && !lower.includes('decision')) {
    if (lower.includes('leads') && !lower.includes('companies')) {
      ambiguities.push({
        field: 'target.type',
        reason: 'The word "leads" could mean companies or contacts. Which are you looking for?',
        clarification_question: 'Are you looking for companies or specific people (e.g., CEOs, founders)?'
      });
    }
  }

  // ── Location ambiguity ──
  if (lower.includes('around') || lower.includes('near') || lower.includes('close to')) {
    ambiguities.push({
      field: 'location',
      reason: 'Location terms like "around" or "near" are vague. Do you mean within the city, the region, or the country?',
      clarification_question: 'Can you specify the exact location? (e.g., city, region, or country)'
    });
  }

  return ambiguities;
}

// ──────────────────────────────────────────────────────────────
// 4. CONTRADICTION DETECTION
// ──────────────────────────────────────────────────────────────

/**
 * Detect contradictions in the request.
 * 
 * Example: "small companies with more than 1,000 employees"
 * Example: "companies in Nigeria and exclude Nigeria"
 */
function detectContradictions(originalRequest, parsed) {
  const contradictions = [];
  const lower = originalRequest.toLowerCase();

  // ── Size contradiction ──
  // "small" vs "1000+ employees"
  if (parsed.company && parsed.company.size) {
    const size = parsed.company.size.toLowerCase();
    if (size === 'small' && lower.includes('1000')) {
      contradictions.push({
        field: 'company.size',
        reason: '"Small company" contradicts "1000+ employees". Small companies typically have fewer than 50 employees.',
        suggestion: 'Would you like to search for small companies (1-50 employees) or large companies (1000+ employees)?'
      });
    }
    if (size === 'large' && lower.includes('10 employees')) {
      contradictions.push({
        field: 'company.size',
        reason: '"Large company" contradicts "10 employees". Large companies typically have 200+ employees.',
        suggestion: 'Would you like to search for small companies (1-50 employees) or large companies (200+ employees)?'
      });
    }
  }

  // ── Location contradiction ──
  if (lower.includes('nigeria') && lower.includes('exclude nigeria')) {
    contradictions.push({
      field: 'location',
      reason: 'You asked for companies in Nigeria but also said to exclude Nigeria. This is contradictory.',
      suggestion: 'Would you like to search in Nigeria or exclude Nigeria?'
    });
  }

  // ── Contact contradiction ──
  if (parsed.target && parsed.target.type === 'contact' && lower.includes('no contact')) {
    contradictions.push({
      field: 'target.type',
      reason: 'You asked for contacts but also said "no contact". This is contradictory.',
      suggestion: 'Are you looking for companies only or companies with contacts?'
    });
  }

  return contradictions;
}

// ──────────────────────────────────────────────────────────────
// 5. MAIN UNDERSTANDING ENGINE
// ──────────────────────────────────────────────────────────────

class LeadUnderstandingEngine {
  constructor(aiClient) {
    this.aiClient = aiClient;
  }

  /**
   * Process natural language request → structured specification
   */
  async processRequest(userRequest) {
    console.log(`[UNDERSTANDING] Processing: "${userRequest}"`);

    try {
      // Step 1: Parse with AI
      const parsed = await this.parseWithAI(userRequest);
      
      // Step 2: Normalize values
      const normalized = this.normalize(parsed);
      
      // Step 3: Detect ambiguities (rule-based)
      const ambiguities = detectAmbiguities(userRequest, normalized);
      
      // Step 4: Detect contradictions (rule-based)
      const contradictions = detectContradictions(userRequest, normalized);
      
      // Step 5: Classify requirements
      const classified = this.classifyRequirements(userRequest, normalized);
      
      // Step 6: Build the contract
      const spec = this.buildContract(userRequest, normalized, ambiguities, contradictions, classified);
      
      // Step 7: Validate the contract
      const validated = this.validateContract(spec);
      
      console.log(`[UNDERSTANDING] Status: ${validated.status}, RequestId: ${validated.requestId}`);
      return validated;
      
    } catch (error) {
      console.error('[UNDERSTANDING] Error:', error.message);
      return this.buildErrorSpec(userRequest, error.message);
    }
  }

  /**
   * Parse with AI — returns raw parsed data
   */
  async parseWithAI(userRequest) {
    const prompt = `
You are Skyline AA-1's Lead Request Understanding Engine.
Convert the user's request into structured data.

**RULES (CRITICAL — DO NOT BREAK):**

1. NEVER invent requirements — if not specified, use null or []
2. "Any" means the user EXPLICITLY said "any" — otherwise use null
3. Normalize terminology (CEO → CEO, SaaS → SaaS, Germany → DE)
4. Distinguish between:
   - "must have" (hard requirements)
   - "nice to have" (preferences)
   - "must not have" (exclusions)
5. If a phrase has multiple meanings, flag it as ambiguous
6. If the request contradicts itself, flag it as contradictory

**Output JSON:**
{
  "target": { "type": "company|contact|both", "role": "string|null", "quantity": "number|null" },
  "company": { 
    "industry": ["string"], 
    "size": "string|null",
    "age": "string|null",
    "funding": "string|null",
    "businessType": ["string"],
    "technologies": ["string"]
  },
  "location": { "city": "string|null", "region": "string|null", "country": "string|null" },
  "requirements": { "hard": ["string"], "soft": ["string"], "excluded": ["string"] },
  "confidence": 0.0,
  "raw": "string"
}

**Examples:**

User: "Find CEOs of SaaS companies in London"
Output: {
  "target": { "type": "contact", "role": "CEO", "quantity": null },
  "company": { "industry": ["SaaS"], "size": null, "age": null, "funding": null, "businessType": [], "technologies": [] },
  "location": { "city": "London", "region": null, "country": null },
  "requirements": { "hard": ["Industry: SaaS", "Location: London", "Role: CEO"], "soft": [], "excluded": [] },
  "confidence": 0.99,
  "raw": "Find CEOs of SaaS companies in London"
}

User: "I need 50 cybersecurity companies in Germany with 100+ employees. I want decision makers and their verified business emails."
Output: {
  "target": { "type": "contact", "role": "Decision Maker", "quantity": 50 },
  "company": { "industry": ["Cybersecurity"], "size": "medium", "age": null, "funding": null, "businessType": [], "technologies": [] },
  "location": { "city": null, "region": null, "country": "Germany" },
  "requirements": { "hard": ["Industry: Cybersecurity", "Location: Germany", "Company Size: medium", "Role: Decision Maker"], "soft": [], "excluded": [] },
  "confidence": 0.98,
  "raw": "I need 50 cybersecurity companies in Germany with 100+ employees. I want decision makers and their verified business emails."
}

User: "Find me tech businesses in London, preferably startups"
Output: {
  "target": { "type": "company", "role": null, "quantity": null },
  "company": { "industry": ["Technology"], "size": null, "age": "startup", "funding": null, "businessType": [], "technologies": [] },
  "location": { "city": "London", "region": null, "country": null },
  "requirements": { "hard": ["Location: London"], "soft": ["Company Age: startup"], "excluded": [] },
  "confidence": 0.85,
  "raw": "Find me tech businesses in London, preferably startups"
}

**User Request:**
"${userRequest}"

**OUTPUT ONLY JSON. NO MARKDOWN.**
`;

    const response = await this.aiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You extract structured data from lead requests. Distinguish hard vs soft requirements. Output only JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    });

    return JSON.parse(response.choices[0].message.content);
  }

  /**
   * Normalize values
   */
  normalize(parsed) {
    const result = JSON.parse(JSON.stringify(parsed));

    // Normalize location
    if (result.location) {
      if (result.location.country) {
        const countryLower = result.location.country.toLowerCase();
        const code = COUNTRY_TO_CODE[countryLower];
        if (code) {
          result.location.countryCode = code;
          result.location.country = CODE_TO_COUNTRY[code] || result.location.country;
        }
      }
    }

    // Normalize industry
    if (result.company && result.company.industry) {
      result.company.industry = result.company.industry.map(i => {
        const normalized = INDUSTRY_MAPPINGS[i.toLowerCase()];
        return normalized || i;
      });
    }

    // Normalize role
    if (result.target && result.target.role) {
      const normalized = ROLE_MAPPINGS[result.target.role.toLowerCase()];
      if (normalized) result.target.role = normalized;
    }

    // Normalize size
    if (result.company && result.company.size) {
      const sizeLower = result.company.size.toLowerCase();
      result.company.size = SIZE_MAPPINGS[sizeLower] || sizeLower;
    }

    // Normalize "preferably" → soft requirement
    if (result.requirements && result.requirements.soft) {
      result.requirements.soft = result.requirements.soft.map(req => {
        if (req.toLowerCase().includes('startup')) {
          return 'Company Age: startup (preferred)';
        }
        return req;
      });
    }

    return result;
  }

  /**
   * Classify requirements — separate hard vs soft vs excluded
   */
  classifyRequirements(userRequest, parsed) {
    const hard = [];
    const soft = [];
    const excluded = [];
    const lower = userRequest.toLowerCase();

    // ── Industry ──
    if (parsed.company && parsed.company.industry && parsed.company.industry.length > 0) {
      hard.push(`Industry: ${parsed.company.industry.join(', ')}`);
    }

    // ── Location ──
    if (parsed.location) {
      if (parsed.location.country) {
        hard.push(`Location: ${parsed.location.country}`);
      }
      if (parsed.location.city) {
        hard.push(`Location: ${parsed.location.city}`);
      }
      if (parsed.location.region) {
        hard.push(`Location: ${parsed.location.region}`);
      }
    }

    // ── Role ──
    if (parsed.target && parsed.target.role) {
      hard.push(`Role: ${parsed.target.role}`);
    }

    // ── Quantity ──
    if (parsed.target && parsed.target.quantity) {
      hard.push(`Quantity: ${parsed.target.quantity}`);
    }

    // ── Size ──
    if (parsed.company && parsed.company.size) {
      // Check if it's a preference or hard requirement
      if (lower.includes('prefer') || lower.includes('preferably') || lower.includes('ideally')) {
        soft.push(`Company Size: ${parsed.company.size} (preferred)`);
      } else {
        hard.push(`Company Size: ${parsed.company.size}`);
      }
    }

    // ── Age ──
    if (parsed.company && parsed.company.age) {
      if (lower.includes('prefer') || lower.includes('preferably') || lower.includes('ideally')) {
        soft.push(`Company Age: ${parsed.company.age} (preferred)`);
      } else {
        hard.push(`Company Age: ${parsed.company.age}`);
      }
    }

    // ── Funding ──
    if (parsed.company && parsed.company.funding) {
      if (lower.includes('prefer') || lower.includes('preferably') || lower.includes('ideally')) {
        soft.push(`Funding: ${parsed.company.funding} (preferred)`);
      } else {
        hard.push(`Funding: ${parsed.company.funding}`);
      }
    }

    // ── Business Type ──
    if (parsed.company && parsed.company.businessType && parsed.company.businessType.length > 0) {
      parsed.company.businessType.forEach(type => {
        if (lower.includes('exclude') || lower.includes('not')) {
          excluded.push(`Business Type: ${type}`);
        } else if (lower.includes('prefer') || lower.includes('preferably') || lower.includes('ideally')) {
          soft.push(`Business Type: ${type} (preferred)`);
        } else {
          hard.push(`Business Type: ${type}`);
        }
      });
    }

    // ── Technologies ──
    if (parsed.company && parsed.company.technologies && parsed.company.technologies.length > 0) {
      parsed.company.technologies.forEach(tech => {
        if (lower.includes('exclude') || lower.includes('not')) {
          excluded.push(`Technology: ${tech}`);
        } else if (lower.includes('prefer') || lower.includes('preferably') || lower.includes('ideally')) {
          soft.push(`Technology: ${tech} (preferred)`);
        } else {
          hard.push(`Technology: ${tech}`);
        }
      });
    }

    return { hard, soft, excluded };
  }

  /**
   * Build the contract
   */
  buildContract(userRequest, normalized, ambiguities, contradictions, classified) {
    // Determine status
    let status = 'ready';
    if (contradictions.length > 0) {
      status = 'invalid';
    } else if (ambiguities.length > 0) {
      status = 'needs_clarification';
    }

    // Determine contact_required
    const contact_required = normalized.target?.type === 'contact' || 
                            normalized.target?.type === 'both' ||
                            (normalized.target?.role && normalized.target.role !== '');

    // Build confidence
    let confidence = normalized.confidence || 0.85;
    if (ambiguities.length > 0) confidence -= 0.15;
    if (contradictions.length > 0) confidence = 0;

    // Build assumptions
    const assumptions = [];
    if (normalized.location && normalized.location.country && normalized.location.countryCode) {
      assumptions.push({
        type: 'normalization',
        input: normalized.location.country,
        interpretedAs: normalized.location.countryCode,
        reason: 'Country name normalized to ISO code'
      });
    }
    if (normalized.target && normalized.target.role) {
      assumptions.push({
        type: 'normalization',
        input: normalized.target.role,
        interpretedAs: normalized.target.role,
        reason: 'Role normalized to standard title'
      });
    }

    const spec = {
      target: {
        type: normalized.target?.type || null,
        role: normalized.target?.role || null,
        quantity: normalized.target?.quantity || null
      },
      company: {
        industry: normalized.company?.industry || [],
        size: {
          value: normalized.company?.size || null,
          restricted: !!normalized.company?.size
        },
        age: {
          value: normalized.company?.age || null,
          restricted: !!normalized.company?.age
        },
        funding: {
          value: normalized.company?.funding || null,
          restricted: !!normalized.company?.funding
        },
        businessType: normalized.company?.businessType || [],
        technologies: normalized.company?.technologies || []
      },
      location: {
        city: normalized.location?.city || null,
        region: normalized.location?.region || null,
        country: normalized.location?.country || null,
        countryCode: normalized.location?.countryCode || null,
        restrictions: {
          type: 'include',
          value: null
        }
      },
      requirements: {
        hard: classified.hard || [],
        soft: classified.soft || [],
        excluded: classified.excluded || []
      },
      contact_required: contact_required,
      interpretation: {
        confidence: Math.min(1, Math.max(0, confidence)),
        assumptions: assumptions
      },
      status: status,
      ambiguities: ambiguities,
      contradictions: contradictions,
      originalRequest: userRequest,
      requestId: `lead-${uuidv4().substring(0, 8)}`,
      processedAt: new Date().toISOString(),
      version: '2.0.0'
    };

    return spec;
  }

  /**
   * Validate the contract — strict final validation
   */
  validateContract(spec) {
    const validated = JSON.parse(JSON.stringify(spec));

    // ── Validate target ──
    if (!validated.target || !validated.target.type) {
      validated.status = 'invalid';
      validated.ambiguities.push({
        field: 'target.type',
        reason: 'Target type is required but was not specified.',
        clarification_question: 'Are you looking for companies, contacts, or both?'
      });
    } else if (!['company', 'contact', 'both'].includes(validated.target.type)) {
      validated.target.type = null;
      validated.status = 'invalid';
      validated.ambiguities.push({
        field: 'target.type',
        reason: `Invalid target type: "${spec.target.type}". Must be "company", "contact", or "both".`,
        clarification_question: 'Are you looking for companies, contacts, or both?'
      });
    }

    // ── Validate quantity ──
    if (validated.target && validated.target.quantity !== null) {
      if (typeof validated.target.quantity !== 'number' || validated.target.quantity < 1) {
        validated.target.quantity = null;
        validated.ambiguities.push({
          field: 'target.quantity',
          reason: 'Quantity must be a positive number.',
          clarification_question: 'How many leads would you like?'
        });
      }
    }

    // ── Validate status ──
    if (!['ready', 'needs_clarification', 'invalid'].includes(validated.status)) {
      validated.status = 'ready';
    }

    // ── If contradictions exist, status must be invalid ──
    if (validated.contradictions && validated.contradictions.length > 0) {
      validated.status = 'invalid';
    }

    // ── If ambiguities exist and no contradictions, status is needs_clarification ──
    if (validated.ambiguities && validated.ambiguities.length > 0 && validated.status !== 'invalid') {
      validated.status = 'needs_clarification';
    }

    // ── Ensure required fields exist ──
    validated.target = validated.target || { type: null, role: null, quantity: null };
    validated.company = validated.company || { industry: [], size: { value: null, restricted: false }, age: { value: null, restricted: false }, funding: { value: null, restricted: false }, businessType: [], technologies: [] };
    validated.location = validated.location || { city: null, region: null, country: null, countryCode: null, restrictions: { type: 'include', value: null } };
    validated.requirements = validated.requirements || { hard: [], soft: [], excluded: [] };
    validated.ambiguities = validated.ambiguities || [];
    validated.contradictions = validated.contradictions || [];
    validated.interpretation = validated.interpretation || { confidence: 0.5, assumptions: [] };

    return validated;
  }

  /**
   * Build error specification — safe failure, no guessing
   */
  buildErrorSpec(userRequest, errorMessage) {
    return {
      target: { type: null, role: null, quantity: null },
      company: { industry: [], size: { value: null, restricted: false }, age: { value: null, restricted: false }, funding: { value: null, restricted: false }, businessType: [], technologies: [] },
      location: { city: null, region: null, country: null, countryCode: null, restrictions: { type: null, value: null } },
      requirements: { hard: [], soft: [], excluded: [] },
      contact_required: false,
      interpretation: {
        confidence: 0,
        assumptions: []
      },
      status: 'invalid',
      ambiguities: [
        { 
          field: 'error', 
          reason: errorMessage, 
          clarification_question: 'Please try rephrasing your request.' 
        }
      ],
      contradictions: [],
      originalRequest: userRequest,
      requestId: `lead-${uuidv4().substring(0, 8)}`,
      processedAt: new Date().toISOString(),
      version: '2.0.0'
    };
  }
}

// ──────────────────────────────────────────────────────────────
// 6. CONVENIENCE FUNCTION
// ──────────────────────────────────────────────────────────────

/**
 * Quick helper: create engine, process request
 */
async function understand(userRequest) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  const engine = new LeadUnderstandingEngine(openai);
  return await engine.processRequest(userRequest);
}

// ──────────────────────────────────────────────────────────────
// 7. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
  LeadUnderstandingEngine,
  understand,
  CONTRACT_SCHEMA,
  COUNTRY_TO_CODE,
  CODE_TO_COUNTRY,
  INDUSTRY_MAPPINGS,
  ROLE_MAPPINGS,
  SIZE_MAPPINGS,
  SIZE_TO_RANGE,
  detectAmbiguities,
  detectContradictions
};
