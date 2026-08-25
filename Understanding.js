// ──────────────────────────────────────────────────────────────
// UNDERSTANDING.JS — Lead Request Understanding Engine
// Phase 4: Lead Intelligence — Stage 1
// ──────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');

// ──────────────────────────────────────────────────────────────
// 1. SCHEMA DEFINITION
// ──────────────────────────────────────────────────────────────

const LEAD_SPECIFICATION_SCHEMA = {
  requestId: { type: 'string', required: true },
  target: {
    type: 'object',
    required: true,
    properties: {
      type: { type: 'string', required: true, enum: ['company', 'contact', 'both'] },
      quantity: { type: 'number', required: false, min: 1 },
      quantityMode: { type: 'string', required: false, enum: ['requested', 'maximum_available'] }
    }
  },
  location: {
    type: 'object',
    required: false,
    properties: {
      include: { type: 'array', items: { type: 'string' } },
      exclude: { type: 'array', items: { type: 'string' } },
      countries: { type: 'array', items: { type: 'string' } },
      regions: { type: 'array', items: { type: 'string' } },
      cities: { type: 'array', items: { type: 'string' } }
    }
  },
  company: {
    type: 'object',
    required: false,
    properties: {
      industries: { type: 'array', items: { type: 'string' } },
      employeeRange: {
        type: 'object',
        required: false,
        properties: {
          min: { type: 'number' },
          max: { type: 'number' }
        }
      },
      revenueRange: {
        type: 'object',
        required: false,
        properties: {
          min: { type: 'number' },
          max: { type: 'number' }
        }
      },
      businessTypes: { type: 'array', items: { type: 'string' } },
      technologies: { type: 'array', items: { type: 'string' } }
    }
  },
  contact: {
    type: 'object',
    required: false,
    properties: {
      required: { type: 'boolean', required: true },
      intent: { type: 'string', required: false, enum: ['decision_maker', 'influencer', 'end_user', null] },
      roles: { type: 'array', items: { type: 'string' } }
    }
  },
  data: {
    type: 'object',
    required: false,
    properties: {
      requiredFields: { type: 'array', items: { type: 'string' } },
      email: { type: 'boolean' },
      businessEmail: { type: 'boolean' },
      emailVerification: { type: 'boolean' },
      linkedin: { type: 'boolean' },
      phone: { type: 'boolean' }
    }
  },
  hardRequirements: { type: 'array', items: { type: 'string' } },
  preferences: { type: 'array', items: { type: 'string' } },
  exclusions: { type: 'array', items: { type: 'string' } },
  ambiguities: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        field: { type: 'string' },
        reason: { type: 'string' }
      }
    }
  },
  status: { type: 'string', required: true, enum: ['ready', 'needs_clarification', 'invalid'] }
};

// ──────────────────────────────────────────────────────────────
// 2. NORMALIZATION MAPPINGS
// ──────────────────────────────────────────────────────────────

const COUNTRY_MAPPINGS = {
  'germany': 'DE',
  'german': 'DE',
  'deutschland': 'DE',
  'france': 'FR',
  'french': 'FR',
  'united kingdom': 'GB',
  'uk': 'GB',
  'britain': 'GB',
  'nigeria': 'NG',
  'usa': 'US',
  'united states': 'US',
  'america': 'US',
  'canada': 'CA',
  'australia': 'AU',
  'india': 'IN',
  'china': 'CN',
  'japan': 'JP',
  'singapore': 'SG'
};

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
  'blockchain': 'Blockchain',
  'real estate': 'Real Estate',
  'education': 'Education',
  'edtech': 'EdTech',
  'hr': 'HR',
  'human resources': 'HR'
};

const BUSINESS_TYPE_MAPPINGS = {
  'startup': 'Startup',
  'start-up': 'Startup',
  'start up': 'Startup',
  'agency': 'Agency',
  'enterprise': 'Enterprise',
  'public company': 'Public',
  'private company': 'Private',
  'public': 'Public',
  'private': 'Private',
  'b2b': 'B2B',
  'b2c': 'B2C'
};

const ROLE_MAPPINGS = {
  'ceo': 'CEO',
  'cfo': 'CFO',
  'cto': 'CTO',
  'ciso': 'CISO',
  'cmo': 'CMO',
  'coo': 'COO',
  'founder': 'Founder',
  'co-founder': 'Co-Founder',
  'director': 'Director',
  'vp': 'VP',
  'vice president': 'VP',
  'head': 'Head',
  'manager': 'Manager',
  'owner': 'Owner',
  'president': 'President'
};

// ──────────────────────────────────────────────────────────────
// 3. HELPER FUNCTIONS
// ──────────────────────────────────────────────────────────────

function normalizeCountry(input) {
  if (!input) return input;
  const normalized = input.trim().toLowerCase();
  return COUNTRY_MAPPINGS[normalized] || input;
}

function normalizeIndustry(input) {
  if (!input) return input;
  const normalized = input.trim().toLowerCase();
  return INDUSTRY_MAPPINGS[normalized] || input;
}

function normalizeBusinessType(input) {
  if (!input) return input;
  const normalized = input.trim().toLowerCase();
  return BUSINESS_TYPE_MAPPINGS[normalized] || input;
}

function normalizeRole(input) {
  if (!input) return input;
  const normalized = input.trim().toLowerCase();
  return ROLE_MAPPINGS[normalized] || input;
}

function normalizeArray(arr, mappingFn) {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map(item => mappingFn(item)).filter(Boolean);
}

function extractNumberFromString(text, pattern) {
  if (!text) return null;
  const match = text.match(pattern);
  if (match) return parseInt(match[1], 10);
  return null;
}

function isValidLeadSpec(spec) {
  try {
    if (!spec.requestId || !spec.target || !spec.target.type) return false;
    if (!spec.status || !['ready', 'needs_clarification', 'invalid'].includes(spec.status)) return false;
    if (!['company', 'contact', 'both'].includes(spec.target.type)) return false;
    if (spec.target.quantity !== null && spec.target.quantity !== undefined) {
      if (typeof spec.target.quantity !== 'number' || spec.target.quantity < 1) return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function generateRequestId() {
  return `lead-${uuidv4().substring(0, 8)}`;
}

/**
 * Detect TRUE ambiguity — language that cannot be safely interpreted
 * (doc §16). This is distinct from unspecified/unknown information
 * (doc §15), which should stay as null/[] WITHOUT being flagged here.
 * Missing location or missing quantity are not, by themselves,
 * ambiguous — they're just unknown, and inventing a flag for every
 * unspecified field would make "needs_clarification" fire on nearly
 * every request.
 */
function detectAmbiguity(spec) {
  const ambiguities = [];

  // Check for vague "need" language — cannot be safely interpreted
  // without more context (security needs? hiring needs? something else?)
  if (spec.originalRequest && /\bneed(s|ed)?\b/i.test(spec.originalRequest)) {
    ambiguities.push({
      field: 'intent',
      reason: 'The word "need" is ambiguous. Could mean security needs, hiring needs, or other requirements.'
    });
  }

  // Missing/invalid target type is a genuine ambiguity — target is a
  // required field the rest of the pipeline cannot proceed without.
  if (!spec.target || !spec.target.type) {
    ambiguities.push({
      field: 'target',
      reason: 'Target type not specified. Defaulting to "company".'
    });
  }

  return ambiguities;
}

// ──────────────────────────────────────────────────────────────
// 4. AI PARSER PROMPT CONSTRUCTION
// ──────────────────────────────────────────────────────────────

function buildUnderstandingPrompt(userRequest) {
  return `
You are Skyline AA-1's Lead Request Understanding Engine.
Convert the user's natural language request into a structured Lead Search Specification.

**RULES (CRITICAL):**
1. NEVER invent missing requirements — if not specified, use null or []
2. Separate hard requirements from preferences
3. Distinguish between company leads and contact leads
4. Detect ambiguity and flag it
5. Normalize terminology (Germany → DE, SaaS → SaaS)
6. Extract: Target, Location, Company Requirements, Contact Requirements, Data Requirements, Quantity

**OUTPUT FORMAT (JSON only, no markdown):**
{
  "target": { 
    "type": "company|contact|both", 
    "quantity": null, 
    "quantityMode": "requested" 
  },
  "location": { 
    "include": [], 
    "exclude": [], 
    "countries": [], 
    "regions": [], 
    "cities": [] 
  },
  "company": { 
    "industries": [], 
    "employeeRange": null, 
    "revenueRange": null, 
    "businessTypes": [], 
    "technologies": [] 
  },
  "contact": { 
    "required": false, 
    "intent": null, 
    "roles": [] 
  },
  "data": { 
    "requiredFields": [], 
    "email": false, 
    "businessEmail": false, 
    "emailVerification": false, 
    "linkedin": false, 
    "phone": false 
  },
  "hardRequirements": [],
  "preferences": [],
  "exclusions": [],
  "ambiguities": [],
  "status": "ready"
}

**EXAMPLES:**

User: "Find 300 cybersecurity companies in Germany with 50-500 employees. I want decision makers and their verified business emails."
Output: {
  "target": { "type": "company", "quantity": 300, "quantityMode": "requested" },
  "location": { "include": ["DE"], "exclude": [], "countries": [], "regions": [], "cities": [] },
  "company": { "industries": ["Cybersecurity"], "employeeRange": { "min": 50, "max": 500 }, "revenueRange": null, "businessTypes": [], "technologies": [] },
  "contact": { "required": true, "intent": "decision_maker", "roles": [] },
  "data": { "requiredFields": ["companyName", "email", "contactName", "jobTitle"], "email": true, "businessEmail": true, "emailVerification": true, "linkedin": false, "phone": false },
  "hardRequirements": ["Germany", "Cybersecurity", "50-500 employees", "Decision maker contact"],
  "preferences": [],
  "exclusions": [],
  "ambiguities": [],
  "status": "ready"
}

**User Request:**
"${userRequest}"

**OUTPUT ONLY JSON. NO MARKDOWN, NO EXPLANATIONS.**
`;
}

// ──────────────────────────────────────────────────────────────
// 5. MAIN UNDERSTANDING ENGINE
// ──────────────────────────────────────────────────────────────

class LeadUnderstandingEngine {
  constructor(aiClient) {
    this.aiClient = aiClient;
  }

  /**
   * Process a natural language lead request
   * @param {string} userRequest - Natural language request from user
   * @param {object} options - Optional overrides
   * @returns {Promise<object>} Validated Lead Search Specification
   */
  async processRequest(userRequest, options = {}) {
    try {
      console.log(`[UNDERSTANDING] Processing: "${userRequest}"`);

      // Step 1: Get AI interpretation
      const aiOutput = await this.getAIInterpretation(userRequest);

      // Step 2: Add original request for context
      aiOutput.originalRequest = userRequest;

      // Step 3: Normalize the output
      const normalized = this.normalizeSpecification(aiOutput);

      // Step 4: Validate schema + detect ambiguity + resolve status
      const validated = this.validateSpecification(normalized);

      // Step 5: Add request ID and metadata
      const finalSpec = this.enrichSpecification(validated, userRequest);

      // Step 6: Deterministic gate — never let a malformed spec leave
      // this stage (doc §17: AI is not the final authority on structure)
      if (!isValidLeadSpec(finalSpec)) {
        console.error('[UNDERSTANDING] Final spec failed validation gate:', finalSpec.requestId);
        return this.createErrorSpecification(userRequest, 'Specification failed final schema validation.');
      }

      console.log(`[UNDERSTANDING] Status: ${finalSpec.status}, RequestId: ${finalSpec.requestId}`);
      return finalSpec;
    } catch (error) {
      console.error('[UNDERSTANDING] Error processing request:', error);
      return this.createErrorSpecification(userRequest, error.message);
    }
  }

  /**
   * Get AI interpretation of the request
   */
  async getAIInterpretation(userRequest) {
    try {
      const prompt = buildUnderstandingPrompt(userRequest);

      const response = await this.aiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a lead request understanding engine. Output only valid JSON. Never invent missing data.'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 800,
        temperature: 0.2,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0].message.content;
      return JSON.parse(content);
    } catch (error) {
      console.error('[UNDERSTANDING] AI parsing failed:', error);
      throw new Error(`Failed to parse lead request: ${error.message}`);
    }
  }

  /**
   * Normalize the specification
   */
  normalizeSpecification(spec) {
    const normalized = { ...spec };

    // Normalize location
    if (normalized.location) {
      if (normalized.location.include) {
        normalized.location.include = normalized.location.include
          .map(c => normalizeCountry(c))
          .filter(Boolean);
      }
      if (normalized.location.countries) {
        normalized.location.countries = normalized.location.countries
          .map(c => normalizeCountry(c))
          .filter(Boolean);
      }
      if (normalized.location.exclude) {
        normalized.location.exclude = normalized.location.exclude
          .map(c => normalizeCountry(c))
          .filter(Boolean);
      }
      if (normalized.location.regions) {
        normalized.location.regions = normalized.location.regions
          .map(r => r.trim())
          .filter(Boolean);
      }
      if (normalized.location.cities) {
        normalized.location.cities = normalized.location.cities
          .map(c => c.trim())
          .filter(Boolean);
      }
    }

    // Normalize company
    if (normalized.company) {
      if (normalized.company.industries) {
        normalized.company.industries = normalized.company.industries
          .map(i => normalizeIndustry(i))
          .filter(Boolean);
      }
      if (normalized.company.businessTypes) {
        normalized.company.businessTypes = normalized.company.businessTypes
          .map(b => normalizeBusinessType(b))
          .filter(Boolean);
      }
      if (normalized.company.technologies) {
        normalized.company.technologies = normalized.company.technologies
          .map(t => t.trim())
          .filter(Boolean);
      }
    }

    // Normalize contact roles
    if (normalized.contact && normalized.contact.roles) {
      normalized.contact.roles = normalized.contact.roles
        .map(r => normalizeRole(r))
        .filter(Boolean);
    }

    return normalized;
  }

  /**
   * Validate the specification against the schema, detect ambiguity,
   * and resolve the final status from what was actually found.
   */
  validateSpecification(spec) {
    // Ensure all required fields exist
    spec.target = spec.target || { type: 'company', quantity: null, quantityMode: 'requested' };
    spec.location = spec.location || { include: [], exclude: [], countries: [], regions: [], cities: [] };
    spec.company = spec.company || { industries: [], employeeRange: null, revenueRange: null, businessTypes: [], technologies: [] };
    spec.contact = spec.contact || { required: false, intent: null, roles: [] };
    spec.data = spec.data || { requiredFields: [], email: false, businessEmail: false, emailVerification: false, linkedin: false, phone: false };
    spec.hardRequirements = spec.hardRequirements || [];
    spec.preferences = spec.preferences || [];
    spec.exclusions = spec.exclusions || [];
    spec.ambiguities = spec.ambiguities || [];

    // Validate target type
    if (!['company', 'contact', 'both'].includes(spec.target.type)) {
      spec.target.type = 'company';
      spec.ambiguities.push({
        field: 'target.type',
        reason: 'Invalid target type. Defaulted to "company".'
      });
    }

    // Validate quantity
    if (spec.target.quantity && (typeof spec.target.quantity !== 'number' || spec.target.quantity < 1)) {
      spec.target.quantity = null;
      spec.ambiguities.push({
        field: 'target.quantity',
        reason: 'Invalid quantity. Defaulted to null (as many as possible).'
      });
    }

    // Detect additional true ambiguities (doc §16) — kept separate from
    // "unknown information" (doc §15), which is never flagged here.
    const detectedAmbiguities = detectAmbiguity(spec);
    spec.ambiguities = [...spec.ambiguities, ...detectedAmbiguities];

    // Resolve status from what was actually found, per doc §20.
    // Don't downgrade a status the AI already marked "invalid".
    if (spec.status !== 'invalid') {
      spec.status = spec.ambiguities.length > 0 ? 'needs_clarification' : 'ready';
    }
    if (!['ready', 'needs_clarification', 'invalid'].includes(spec.status)) {
      spec.status = spec.ambiguities.length > 0 ? 'needs_clarification' : 'ready';
    }

    return spec;
  }

  /**
   * Enrich with metadata
   */
  enrichSpecification(spec, userRequest) {
    return {
      ...spec,
      requestId: generateRequestId(),
      originalRequest: userRequest,
      processedAt: new Date().toISOString(),
      version: '1.0.0'
    };
  }

  /**
   * Create an error specification
   */
  createErrorSpecification(userRequest, errorMessage) {
    return {
      requestId: generateRequestId(),
      target: { type: 'company', quantity: null, quantityMode: 'requested' },
      location: { include: [], exclude: [], countries: [], regions: [], cities: [] },
      company: { industries: [], employeeRange: null, revenueRange: null, businessTypes: [], technologies: [] },
      contact: { required: false, intent: null, roles: [] },
      data: { requiredFields: [], email: false, businessEmail: false, emailVerification: false, linkedin: false, phone: false },
      hardRequirements: [],
      preferences: [],
      exclusions: [],
      ambiguities: [{ field: 'error', reason: errorMessage }],
      status: 'invalid',
      originalRequest: userRequest,
      processedAt: new Date().toISOString(),
      version: '1.0.0'
    };
  }

  /**
   * Helper: Quick parse for testing
   */
  async quickParse(userRequest) {
    return await this.processRequest(userRequest);
  }

  /**
   * Helper: Get schema
   */
  getSchema() {
    return LEAD_SPECIFICATION_SCHEMA;
  }
}

// ──────────────────────────────────────────────────────────────
// 6. EXPORT
// ──────────────────────────────────────────────────────────────

module.exports = {
  LeadUnderstandingEngine,
  normalizeCountry,
  normalizeIndustry,
  normalizeBusinessType,
  normalizeRole,
  normalizeArray,
  extractNumberFromString,
  isValidLeadSpec,
  generateRequestId,
  buildUnderstandingPrompt,
  detectAmbiguity,
  LEAD_SPECIFICATION_SCHEMA,
  COUNTRY_MAPPINGS,
  INDUSTRY_MAPPINGS,
  BUSINESS_TYPE_MAPPINGS,
  ROLE_MAPPINGS
};
