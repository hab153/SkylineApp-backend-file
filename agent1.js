'use strict';

/**
 * agent1.js – Stage 1: Query Understanding Engine
 * 
 * The first and most important stage of Skyline's Lead Intelligence Engine.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read the raw user request carefully.
 * 2. Extract all structured entities (country, industry, service, amount, etc.)
 * 3. Detect missing information and ambiguity.
 * 4. Validate the request (reasonable amounts, valid countries/industries).
 * 5. Detect the user's primary intent (find companies, startups, investors, etc.)
 * 6. Create a standardized search package for downstream stages.
 * 
 * YOU MUST NOT:
 * - Search for leads.
 * - Generate hypotheses (Stage 2).
 * - Enrich or score companies.
 * - Route to other pipelines.
 * - Produce long explanations.
 * - Invent missing facts without flagging them.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const UNDERSTAND_MODEL = 'gpt-4o-mini';
const FALLBACK_MODEL = 'gpt-4o';
const MAX_OUTPUT_TOKENS = 600;

// Valid entities for validation
const VALID_COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan',
  'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi',
  'Cabo Verde', 'Cambodia', 'Cameroon', 'Canada', 'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros', 'Congo', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czech Republic',
  'Denmark', 'Djibouti', 'Dominica', 'Dominican Republic',
  'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia',
  'Fiji', 'Finland', 'France',
  'Gabon', 'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana',
  'Haiti', 'Honduras', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy',
  'Jamaica', 'Japan', 'Jordan',
  'Kazakhstan', 'Kenya', 'Kiribati', 'Korea', 'Kuwait', 'Kyrgyzstan',
  'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg',
  'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique',
  'Myanmar',
  'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Macedonia', 'Norway',
  'Oman',
  'Pakistan', 'Palau', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal',
  'Qatar',
  'Romania', 'Russia', 'Rwanda',
  'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines', 'Samoa', 'San Marino', 'Sao Tome and Principe', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria',
  'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand', 'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Turkmenistan', 'Tuvalu',
  'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan',
  'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam',
  'Yemen',
  'Zambia', 'Zimbabwe'
];

const VALID_INDUSTRIES = [
  'Aerospace', 'Agriculture', 'Automotive', 'Banking', 'Biotechnology', 'Chemicals', 'Construction', 'Consumer Goods',
  'Cybersecurity', 'E-commerce', 'Education', 'Electronics', 'Energy', 'Entertainment', 'Environmental', 'Financial Services',
  'Food and Beverage', 'Government', 'Healthcare', 'Hospitality', 'Information Technology', 'Insurance', 'Legal',
  'Logistics', 'Manufacturing', 'Marketing', 'Media', 'Mining', 'Nonprofit', 'Pharmaceuticals', 'Real Estate',
  'Retail', 'SaaS', 'Software', 'Telecommunications', 'Transportation', 'Utilities', 'Waste Management'
];

const VALID_TARGET_TYPES = ['Companies', 'Startups', 'Agencies', 'Decision Makers', 'Investors', 'Partners', 'Competitors', 'Hiring Companies'];

const VALID_LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese', 'Arabic', 'Portuguese', 'Russian', 'Hindi'];

const MIN_REQUESTED_RESULTS = 1;
const MAX_REQUESTED_RESULTS = 10000;

// ────────────────────────────────────────────────────────────────
// 2. The System Prompt (Stage 1: Query Understanding)
// ────────────────────────────────────────────────────────────────

const UNDERSTAND_SYSTEM_PROMPT = `You are Skyline Stage 1: Query Understanding Engine.

Your only job is to understand the user's request, extract structured entities, detect missing information, validate the request, and create a standardized search package for downstream stages.

You must be precise, thorough, and structured.

PRIMARY RESPONSIBILITIES

1. Read the raw user request carefully.
2. Extract all relevant entities:
   - Country / Countries
   - City or Region (if specified)
   - Industry / Industries
   - Service Needed (what the user is selling or looking for)
   - Target Type (Companies, Startups, Agencies, Decision Makers, Investors, Partners, Competitors, Hiring Companies)
   - Amount Requested (number of results)
   - Language preference (if specified)
   - Company Size (if specified)
   - Employee Count range (if specified)
   - Revenue Range (if specified)
   - Technology Stack (if specified)
   - Hiring Activity (if specified)
   - Job Titles (if specified)
   - Business Type (B2B, B2C, D2C, etc.)

3. Detect missing information:
   - If country is missing, flag it.
   - If industry is missing, flag it.
   - If service needed is missing, flag it.
   - If amount is missing, use default of 100.
   - If target type is missing, use default of "Companies".

4. Validate the request:
   - Is the country valid? (check against known countries)
   - Is the industry valid? (check against known industries)
   - Is the requested amount reasonable? (1 to 10,000)
   - Are there contradictory filters? (e.g., "5000 employees" and "startup")

5. Detect the user's primary intent:
   - find_companies
   - find_startups
   - find_agencies
   - find_decision_makers
   - find_investors
   - find_partners
   - find_competitors
   - find_hiring_companies
   - unknown

6. Create a structured search package that every later stage can use.

YOU MUST NOT:
- Search for leads.
- Generate hypotheses (that's Stage 2).
- Enrich or score companies.
- Route to other pipelines.
- Produce long explanations.
- Invent missing facts without flagging them.

CONFIDENCE GUIDELINES
- 0.90 to 1.00 = all critical entities present, clearly understood
- 0.70 to 0.89 = most entities present, some ambiguity
- 0.50 to 0.69 = missing critical entities, needs clarification
- below 0.50 = request too vague, ask for clarification

OUTPUT FORMAT
Return valid JSON only, using this schema:
{
  "intent": string,
  "confidence": number,
  "needs_clarification": boolean,
  "clarification_question": string|null,
  "entities": {
    "countries": string[],
    "city": string|null,
    "region": string|null,
    "industries": string[],
    "service_needed": string|null,
    "target_type": string|null,
    "requested_results": number|null,
    "language": string|null,
    "company_size": string|null,
    "employee_count_min": number|null,
    "employee_count_max": number|null,
    "revenue_min": number|null,
    "revenue_max": number|null,
    "tech_stack": string[],
    "hiring_activity": string|null,
    "job_titles": string[],
    "business_type": string|null
  },
  "missing_fields": string[],
  "validation_errors": string[],
  "search_package": {
    "countries": string[],
    "industries": string[],
    "service_needed": string,
    "target_type": string,
    "requested_results": number,
    "language": string,
    "filters": {
      "company_size": string|null,
      "employee_count_min": number|null,
      "employee_count_max": number|null,
      "revenue_min": number|null,
      "revenue_max": number|null,
      "tech_stack": string[],
      "hiring_activity": string|null,
      "job_titles": string[],
      "business_type": string|null
    }
  },
  "reason": string
}

IMPORTANT
- Be consistent.
- Do not hallucinate entities.
- Do not output extra commentary.
- Do not explain your reasoning beyond the reason field.
- Always prefer safe clarification over incorrect extraction.`;

// ────────────────────────────────────────────────────────────────
// 3. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
        console.warn(`⛔ [Stage1] Non-retryable (${err.response.status}): ${err.message}`);
        return null;
      }
      console.warn(`⚠️ [Stage1] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
      if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 4. Validation Functions
// ────────────────────────────────────────────────────────────────

function validateExtractedData(parsed) {
  const errors = [];
  const missing = [];

  // Validate entities
  const entities = parsed.entities || {};

  // Check countries
  if (entities.countries && entities.countries.length > 0) {
    const invalidCountries = entities.countries.filter(c => !VALID_COUNTRIES.includes(c));
    if (invalidCountries.length > 0) {
      errors.push(`Invalid country/ies: ${invalidCountries.join(', ')}`);
    }
  } else {
    missing.push('country');
  }

  // Check industries
  if (entities.industries && entities.industries.length > 0) {
    const invalidIndustries = entities.industries.filter(i => !VALID_INDUSTRIES.includes(i));
    if (invalidIndustries.length > 0) {
      errors.push(`Invalid industry/ies: ${invalidIndustries.join(', ')}`);
    }
  } else {
    missing.push('industry');
  }

  // Check service_needed
  if (!entities.service_needed) {
    missing.push('service_needed');
  }

  // Check requested_results
  if (entities.requested_results) {
    if (entities.requested_results < MIN_REQUESTED_RESULTS || entities.requested_results > MAX_REQUESTED_RESULTS) {
      errors.push(`Requested results (${entities.requested_results}) must be between ${MIN_REQUESTED_RESULTS} and ${MAX_REQUESTED_RESULTS}`);
    }
  } else {
    // Default to 100 if missing
    entities.requested_results = 100;
  }

  // Check target_type
  if (entities.target_type && !VALID_TARGET_TYPES.includes(entities.target_type)) {
    errors.push(`Invalid target_type: ${entities.target_type}. Must be one of: ${VALID_TARGET_TYPES.join(', ')}`);
  } else if (!entities.target_type) {
    entities.target_type = 'Companies';
    missing.push('target_type (defaulted to Companies)');
  }

  // Check language
  if (entities.language && !VALID_LANGUAGES.includes(entities.language)) {
    errors.push(`Invalid language: ${entities.language}. Must be one of: ${VALID_LANGUAGES.join(', ')}`);
  } else if (!entities.language) {
    entities.language = 'English';
  }

  // Check for contradictory filters
  if (entities.company_size === 'Startup' && entities.employee_count_min && entities.employee_count_min > 100) {
    errors.push('Contradiction: Startup company size with >100 employees is unlikely.');
  }

  return { errors, missing, entities };
}

// ────────────────────────────────────────────────────────────────
// 5. Main Stage 1 Function
// ────────────────────────────────────────────────────────────────

/**
 * Stage 1: Understand the request.
 * Converts natural language into structured search parameters.
 * 
 * @param {Object} params
 * @param {string} params.message - The raw user message.
 * @param {string} params.apiKey - OpenAI API key (required).
 * @param {Array}  params.history - Previous conversation history (optional).
 * @param {string} params.userId - User identifier for logging.
 * @param {Function} params.onProgress - Optional progress callback.
 * @param {boolean} params.autoClarify - If true, automatically ask clarification when needed.
 * 
 * @returns {Object} Structured search package with extraction results.
 */
async function understandRequest({ 
  message, 
  apiKey, 
  history = [], 
  userId = 'anonymous', 
  onProgress = null,
  autoClarify = true
}) {
  // apiKey is REQUIRED
  if (!apiKey) {
    throw new Error('API key is required for Stage 1. Please provide apiKey.');
  }

  console.log(`🧠 [Stage1] Processing request from user ${userId}...`);
  onProgress?.('🧠 Understanding your request...');

  const sanitisedMessage = typeof message === 'string' ? message.slice(0, 1000) : '';
  if (!sanitisedMessage.trim()) {
    return {
      success: false,
      intent: 'unknown',
      confidence: 0,
      needs_clarification: true,
      clarification_question: 'Please describe what kind of leads you\'re looking for. For example: industry, country, company size, or service needed.',
      entities: {},
      missing_fields: ['message'],
      validation_errors: ['Empty request'],
      search_package: null,
      reason: 'Empty or whitespace-only message.'
    };
  }

  const recentHistory = (history || []).slice(-6)
    .map(h => `${h.role || 'user'}: ${h.content || ''}`)
    .join('\n');

  const userPrompt = `
USER REQUEST: "${sanitisedMessage}"
${recentHistory ? `\nRECENT CONVERSATION:\n${recentHistory}` : ''}

Extract structured entities from this request and return valid JSON only.`;

  let result = await callUnderstandModel(UNDERSTAND_MODEL, userPrompt, apiKey);

  // Fallback if primary model fails or returns low confidence
  if (!result || result.confidence < 0.50) {
    console.log(`🔄 [Stage1] Low confidence (${result?.confidence || 0}) – trying fallback model...`);
    onProgress?.('🤔 Clarifying your request...');
    const fallbackResult = await callUnderstandModel(FALLBACK_MODEL, userPrompt, apiKey);
    if (fallbackResult) {
      result = fallbackResult;
    }
  }

  if (!result) {
    return {
      success: false,
      intent: 'unknown',
      confidence: 0,
      needs_clarification: true,
      clarification_question: 'I couldn\'t understand your request. Could you please rephrase it with more details? For example: "Find me 300 healthcare companies in Germany that need cybersecurity."',
      entities: {},
      missing_fields: ['all'],
      validation_errors: ['Stage 1 failed to process request'],
      search_package: null,
      reason: 'Model failed to produce a valid extraction.'
    };
  }

  // Validate extracted data
  const { errors, missing, entities } = validateExtractedData(result);

  // Build search_package
  const searchPackage = {
    countries: entities.countries || [],
    industries: entities.industries || [],
    service_needed: entities.service_needed || null,
    target_type: entities.target_type || 'Companies',
    requested_results: entities.requested_results || 100,
    language: entities.language || 'English',
    filters: {
      company_size: entities.company_size || null,
      employee_count_min: entities.employee_count_min || null,
      employee_count_max: entities.employee_count_max || null,
      revenue_min: entities.revenue_min || null,
      revenue_max: entities.revenue_max || null,
      tech_stack: entities.tech_stack || [],
      hiring_activity: entities.hiring_activity || null,
      job_titles: entities.job_titles || [],
      business_type: entities.business_type || null
    }
  };

  // Determine if clarification is needed
  const criticalMissing = missing.filter(f => ['country', 'industry', 'service_needed'].includes(f));
  const needsClarification = result.needs_clarification || 
                           (result.confidence < 0.50) || 
                           (criticalMissing.length > 0) ||
                           (errors.length > 0);

  let clarificationQuestion = result.clarification_question;
  
  // Auto-generate clarification if needed and not provided
  if (needsClarification && !clarificationQuestion && autoClarify) {
    const missingList = criticalMissing.join(', ');
    if (missingList) {
      clarificationQuestion = `I need a bit more information to help you better. Could you specify: ${missingList}?`;
    } else {
      clarificationQuestion = 'Could you provide more details about what you\'re looking for? For example: industry, country, or what kind of leads you need.';
    }
  }

  // Return structured output
  return {
    success: true,
    intent: result.intent || 'find_companies',
    confidence: result.confidence || 0,
    needs_clarification: needsClarification,
    clarification_question: clarificationQuestion || null,
    entities: entities,
    missing_fields: missing,
    validation_errors: errors,
    search_package: needsClarification ? null : searchPackage, // Only return search package if no clarification needed
    reason: result.reason || 'Stage 1 processed request.',
    raw_result: result // For debugging
  };
}

// ────────────────────────────────────────────────────────────────
// 6. Model Call Helper
// ────────────────────────────────────────────────────────────────

async function callUnderstandModel(model, userPrompt, apiKey) {
  try {
    const response = await withRetry(() => axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: model,
        messages: [
          { role: 'system', content: UNDERSTAND_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.0,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    ), `Stage1:${model}`);

    if (!response) return null;

    const rawContent = response.data.choices[0].message.content.trim();
    const parsed = JSON.parse(rawContent);

    // Validate that parsed contains the required schema fields
    if (!parsed.intent || typeof parsed.confidence !== 'number') {
      console.warn(`⚠️ [Stage1] Invalid schema from ${model} – missing required fields`);
      return null;
    }

    return parsed;

  } catch (error) {
    console.error(`❌ [Stage1] Model call failed (${model}):`, error.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// 7. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  understandRequest,
  VALID_COUNTRIES,
  VALID_INDUSTRIES,
  VALID_TARGET_TYPES,
  VALID_LANGUAGES,
  MIN_REQUESTED_RESULTS,
  MAX_REQUESTED_RESULTS
};
