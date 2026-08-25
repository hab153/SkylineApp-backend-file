// ──────────────────────────────────────────────────────────────
// UNDERSTANDING.JS — Lead Request Understanding Engine
// Layer 1: Convert human intent → precise, validated contract
// 
// RESPONSIBILITIES:
// - Interpret natural language
// - Normalize terminology
// - Detect ambiguity
// - NEVER invent requirements
// - Output clean, predictable structure
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
    type: 'company' | 'contact' | 'both',  // What to find
    role: 'string | null',                   // Specific role if contact
    quantity: 'number | null'                // How many (null = as many as possible)
  },
  company: {
    industry: ['string'],                     // What they do
    size: {
      value: 'string | null',                 // "any", "small", "medium", "large", "enterprise"
      restricted: 'boolean'                   // true = user specified, false = not specified
    },
    age: {
      value: 'string | null',                // "any", "startup", "established"
      restricted: 'boolean'
    },
    funding: {
      value: 'string | null',                // "any", "bootstrapped", "seed", "series_a", etc.
      restricted: 'boolean'
    },
    businessType: ['string'],                // B2B, B2C, agency, enterprise, etc.
    technologies: ['string']                  // Stack they use
  },
  location: {
    city: 'string | null',
    region: 'string | null',
    country: 'string | null',                // Normalized to full country name
    countryCode: 'string | null',            // ISO 2-letter code
    restrictions: {
      type: 'include' | 'exclude',           // include = must be in location, exclude = must NOT be
      value: 'string | null'
    }
  },
  requirements: {
    hard: ['string'],       // MUST have — non-negotiable
    soft: ['string'],       // Nice to have — preferences
    excluded: ['string']    // MUST NOT have
  },
  contact_required: 'boolean',  // true = needs a person, false = company only
  status: 'ready' | 'needs_clarification' | 'invalid',
  ambiguities: [
    {
      field: 'string',
      reason: 'string',
      clarification_question: 'string | null'  // Question to ask the user
    }
  ],
  originalRequest: 'string',
  requestId: 'string',
  processedAt: 'string'
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
  // "technology" is too broad
  if (lower.includes('technology') && !lower.includes('saas') && !lower.includes('software')) {
    ambiguities.push({
      field: 'company.industry',
      reason: '"Technology" is a broad category. Could mean SaaS, hardware, AI, cybersecurity, or IT services.',
      clarification_question: 'What type of technology companies are you looking for? (e.g., SaaS, AI, cybersecurity, hardware, IT services)'
    });
  }

  // ── "tech" shorthand ──
  if (lower.includes('tech') && !lower.includes('saas') && !lower.includes('software')) {
    ambiguities.push({
      field: 'company.industry',
      reason: '"Tech" is ambiguous. Could mean software, hardware, or other technology sectors.',
      clarification_question: 'What specific technology sector? (e.g., SaaS, AI, cybersecurity, fintech)'
    });
  }

  // ── "business" ambiguity ──
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

  // ── Location ambiguity ──
  // "London" alone is clear, but "US" or "UK" can have multiple interpretations
  if (lower.includes('us') || lower.includes('usa') || lower.includes('united states')) {
    // This is actually fine — US is clear enough
  }

  // ── Contact vs Company ambiguity ──
  if (!lower.includes('ceo') && !lower.includes('founder') && !lower.includes('contact') && !lower.includes('decision')) {
    // If they don't mention a person, they might want companies OR contacts
    if (lower.includes('leads') && !lower.includes('companies')) {
      // "leads" implies contacts, but could be companies
      ambiguities.push({
        field: 'target.type',
        reason: 'The word "leads" could mean companies or contacts. Which are you looking for?',
        clarification_question: 'Are you looking for companies or specific people (e.g., CEOs, founders)?'
      });
    }
  }

  return ambiguities;
}

// ──────────────────────────────────────────────────────────────
// 4. MAIN UNDERSTANDING ENGINE
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
      
      // Step 3: Detect ambiguities (rule-based, not AI)
      const ambiguities = detectAmbiguities(userRequest, normalized);
      
      // Step 4: Build the contract
      const spec = this.buildContract(userRequest, normalized, ambiguities);
      
      // Step 5: Validate the contract
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

**RULES:**
1. NEVER invent requirements — if not specified, use null or []
2. "Any" or not specified = null
3. Normalize terminology

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
  "raw": "string"
}

**Examples:**

User: "Find CEOs of SaaS companies in London"
Output: {
  "target": { "type": "contact", "role": "CEO", "quantity": null },
  "company": { "industry": ["SaaS"], "size": null, "age": null, "funding": null, "businessType": [], "technologies": [] },
  "location": { "city": "London", "region": null, "country": null },
  "raw": "Find CEOs of SaaS companies in London"
}

User: "I need 50 cybersecurity companies in Germany with 100+ employees"
Output: {
  "target": { "type": "company", "role": null, "quantity": 50 },
  "company": { "industry": ["Cybersecurity"], "size": "medium", "age": null, "funding": null, "businessType": [], "technologies": [] },
  "location": { "city": null, "region": null, "country": "Germany" },
  "raw": "I need 50 cybersecurity companies in Germany with 100+ employees"
}

User: "Find me tech businesses in London"
Output: {
  "target": { "type": "company", "role": null, "quantity": null },
  "company": { "industry": ["Technology"], "size": null, "age": null, "funding": null, "businessType": [], "technologies": [] },
  "location": { "city": "London", "region": null, "country": null },
  "raw": "Find me tech businesses in London"
}

**User Request:**
"${userRequest}"

**OUTPUT ONLY JSON. NO MARKDOWN.**
`;

    const response = await this.aiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You extract structured data from lead requests. Output only JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 600,
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

    return result;
  }

  /**
   * Build the contract
   */
  buildContract(userRequest, normalized, ambiguities) {
    const spec = {
      target: {
        type: normalized.target?.type || 'company',
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
        hard: [],
        soft: [],
        excluded: []
      },
      contact_required: normalized.target?.type === 'contact' || normalized.target?.type === 'both',
      ambiguities: ambiguities,
      originalRequest: userRequest,
      requestId: `lead-${uuidv4().substring(0, 8)}`,
      processedAt: new Date().toISOString()
    };

    // Build hard requirements
    if (spec.company.industry.length > 0) {
      spec.requirements.hard.push(`Industry: ${spec.company.industry.join(', ')}`);
    }
    if (spec.location.city) {
      spec.requirements.hard.push(`Location: ${spec.location.city}`);
    }
    if (spec.location.country) {
      spec.requirements.hard.push(`Location: ${spec.location.country}`);
    }
    if (spec.target.role) {
      spec.requirements.hard.push(`Role: ${spec.target.role}`);
    }
    if (spec.company.size.value && spec.company.size.restricted) {
      spec.requirements.hard.push(`Company Size: ${spec.company.size.value}`);
    }

    // Set status
    if (ambiguities.length > 0) {
      spec.status = 'needs_clarification';
    } else {
      spec.status = 'ready';
    }

    return spec;
  }

  /**
   * Validate the contract
   */
  validateContract(spec) {
    // Ensure required fields exist
    const validated = JSON.parse(JSON.stringify(spec));
    validated.target = validated.target || { type: 'company', role: null, quantity: null };
    validated.company = validated.company || { industry: [], size: { value: null, restricted: false }, age: { value: null, restricted: false }, funding: { value: null, restricted: false }, businessType: [], technologies: [] };
    validated.location = validated.location || { city: null, region: null, country: null, countryCode: null, restrictions: { type: 'include', value: null } };
    validated.requirements = validated.requirements || { hard: [], soft: [], excluded: [] };
    validated.ambiguities = validated.ambiguities || [];
    validated.status = validated.status || 'ready';

    // Validate status is one of allowed values
    if (!['ready', 'needs_clarification', 'invalid'].includes(validated.status)) {
      validated.status = 'ready';
    }

    // Validate target type
    if (!['company', 'contact', 'both'].includes(validated.target.type)) {
      validated.target.type = 'company';
    }

    return validated;
  }

  /**
   * Build error specification
   */
  buildErrorSpec(userRequest, errorMessage) {
    return {
      target: { type: 'company', role: null, quantity: null },
      company: { industry: [], size: { value: null, restricted: false }, age: { value: null, restricted: false }, funding: { value: null, restricted: false }, businessType: [], technologies: [] },
      location: { city: null, region: null, country: null, countryCode: null, restrictions: { type: 'include', value: null } },
      requirements: { hard: [], soft: [], excluded: [] },
      contact_required: false,
      status: 'invalid',
      ambiguities: [{ field: 'error', reason: errorMessage, clarification_question: 'Please try rephrasing your request.' }],
      originalRequest: userRequest,
      requestId: `lead-${uuidv4().substring(0, 8)}`,
      processedAt: new Date().toISOString()
    };
  }
}

// ──────────────────────────────────────────────────────────────
// 5. CONVENIENCE FUNCTION
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
// 6. EXPORTS
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
  detectAmbiguities
};
