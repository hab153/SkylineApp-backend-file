'use strict';

/**
 * agent2.js – Stage 2: Generate Search Hypotheses (Skyline Intelligence Engine)
 * 
 * The reasoning engine of Skyline's Lead Intelligence System.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Take the structured search package from Stage 1.
 * 2. Generate intelligent search hypotheses based on business knowledge.
 * 3. Answer: "Where is the highest probability of finding companies that match?"
 * 4. Use multiple reasoning categories (industry knowledge, growth, hiring, regulations, etc.)
 * 5. Assign confidence scores to each hypothesis.
 * 6. Prioritize hypotheses with the highest expected value.
 * 7. Return structured hypothesis package for Stage 3.
 * 
 * YOU MUST NOT:
 * - Search for leads (Stage 3 handles this).
 * - Enrich companies (Stage 5 handles this).
 * - Score or rank prospects (Stages 6-7 handle this).
 * - Save results (Stage 8 handles this).
 * - Learn from outcomes (Stage 9 handles this).
 * - Produce long explanations.
 * - Invent facts without flagging them.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const HYPOTHESIS_MODEL = 'gpt-4o-mini';
const FALLBACK_MODEL = 'gpt-4o';
const MAX_OUTPUT_TOKENS = 800;
const MAX_HYPOTHESES = 12;
const MIN_CONFIDENCE_THRESHOLD = 0.20;

// ────────────────────────────────────────────────────────────────
// 2. Industry Knowledge Base (for reasoning)
// ────────────────────────────────────────────────────────────────

const INDUSTRY_SIGNALS = {
  'Healthcare': {
    reasoning: 'Sensitive patient information, strict regulations (HIPAA, GDPR), frequent cyberattacks',
    signals: ['regulatory', 'sensitive_data', 'high_risk'],
    defaultConfidence: 0.92
  },
  'Banking': {
    reasoning: 'Financial data protection, regulatory compliance (PCI-DSS, SOX), high-value targets',
    signals: ['regulatory', 'sensitive_data', 'high_risk'],
    defaultConfidence: 0.94
  },
  'Fintech': {
    reasoning: 'Digital financial services, payment processing, regulatory oversight',
    signals: ['regulatory', 'sensitive_data', 'digital_first', 'growth'],
    defaultConfidence: 0.91
  },
  'SaaS': {
    reasoning: 'Cloud-hosted applications, customer data, security as competitive advantage',
    signals: ['digital_first', 'cloud_infrastructure', 'growth'],
    defaultConfidence: 0.88
  },
  'E-commerce': {
    reasoning: 'Payment processing, customer data, online fraud prevention',
    signals: ['sensitive_data', 'digital_first', 'growth'],
    defaultConfidence: 0.85
  },
  'Manufacturing': {
    reasoning: 'Industrial control systems (OT), supply chain security, increasing digitalization',
    signals: ['digitalization', 'critical_infrastructure', 'growth'],
    defaultConfidence: 0.78
  },
  'Insurance': {
    reasoning: 'Sensitive personal data, regulatory requirements (e.g., NAIC, Solvency II)',
    signals: ['regulatory', 'sensitive_data'],
    defaultConfidence: 0.84
  },
  'Legal': {
    reasoning: 'Confidential client information, regulatory compliance, growing cyber risks',
    signals: ['regulatory', 'sensitive_data'],
    defaultConfidence: 0.76
  },
  'Energy': {
    reasoning: 'Critical infrastructure, operational technology, national security implications',
    signals: ['critical_infrastructure', 'regulatory', 'digitalization'],
    defaultConfidence: 0.82
  },
  'Government': {
    reasoning: 'Public sector IT, citizen data protection, increasing cyber threats',
    signals: ['regulatory', 'sensitive_data', 'critical_infrastructure'],
    defaultConfidence: 0.80
  },
  'Education': {
    reasoning: 'Student and research data, increasing ransomware attacks',
    signals: ['sensitive_data', 'high_risk'],
    defaultConfidence: 0.74
  },
  'Telecommunications': {
    reasoning: 'Critical communications infrastructure, customer data, regulatory oversight',
    signals: ['critical_infrastructure', 'regulatory', 'digital_first'],
    defaultConfidence: 0.86
  },
  'Aerospace': {
    reasoning: 'Intellectual property, export controls, national security',
    signals: ['regulatory', 'critical_infrastructure', 'sensitive_data'],
    defaultConfidence: 0.83
  },
  'Retail': {
    reasoning: 'Customer data, PCI compliance, online and offline fraud prevention',
    signals: ['sensitive_data', 'digitalization'],
    defaultConfidence: 0.72
  },
  'Nonprofit': {
    reasoning: 'Donor data, increasing cyber threats, limited budgets often overlooked',
    signals: ['sensitive_data', 'high_risk'],
    defaultConfidence: 0.65
  },
  'Real Estate': {
    reasoning: 'Financial transactions, personal data, digitalization of property management',
    signals: ['sensitive_data', 'digitalization'],
    defaultConfidence: 0.60
  },
  'Logistics': {
    reasoning: 'Supply chain management, tracking data, operational technology',
    signals: ['digitalization', 'critical_infrastructure'],
    defaultConfidence: 0.68
  },
  'Biotechnology': {
    reasoning: 'Research data, intellectual property, regulatory oversight (FDA, EMA)',
    signals: ['regulatory', 'sensitive_data', 'growth'],
    defaultConfidence: 0.85
  }
};

// ────────────────────────────────────────────────────────────────
// 3. Service-to-Industry Mapping (for dynamic hypothesis generation)
// ────────────────────────────────────────────────────────────────

const SERVICE_INDUSTRY_MAP = {
  'cybersecurity': ['Healthcare', 'Banking', 'Fintech', 'SaaS', 'E-commerce', 'Manufacturing', 'Insurance', 'Energy', 'Government', 'Telecommunications', 'Education', 'Retail', 'Legal', 'Aerospace'],
  'ai automation': ['SaaS', 'Logistics', 'Manufacturing', 'E-commerce', 'Healthcare', 'Marketing', 'Finance', 'Customer Support', 'Retail'],
  'cloud infrastructure': ['SaaS', 'E-commerce', 'Fintech', 'Healthcare', 'Manufacturing', 'Government', 'Telecommunications'],
  'data analytics': ['SaaS', 'E-commerce', 'Healthcare', 'Fintech', 'Manufacturing', 'Retail', 'Logistics'],
  'marketing': ['Retail', 'E-commerce', 'SaaS', 'Healthcare', 'Real Estate', 'Education'],
  'consulting': ['Aerospace', 'Defense', 'Healthcare', 'Energy', 'Government', 'Banking', 'Insurance'],
  'software development': ['SaaS', 'Fintech', 'Healthcare', 'Manufacturing', 'E-commerce', 'Telecommunications'],
  'compliance': ['Banking', 'Insurance', 'Healthcare', 'Aerospace', 'Government', 'Energy'],
  'hr technology': ['SaaS', 'Education', 'Healthcare', 'Retail', 'Manufacturing'],
  'supply chain': ['Manufacturing', 'Logistics', 'Retail', 'E-commerce', 'Healthcare'],
  'iot': ['Manufacturing', 'Energy', 'Logistics', 'Healthcare', 'Agriculture'],
  'blockchain': ['Fintech', 'Banking', 'Supply Chain', 'Logistics', 'Healthcare'],
  'digital transformation': ['Manufacturing', 'Government', 'Energy', 'Retail', 'Healthcare', 'Banking', 'Education']
};

// ────────────────────────────────────────────────────────────────
// 4. The System Prompt (Stage 2: Hypothesis Generation)
// ────────────────────────────────────────────────────────────────

const HYPOTHESIS_SYSTEM_PROMPT = `You are Skyline Stage 2: Search Hypothesis Generator.

Your job is to transform a single search request into multiple intelligent search strategies. Instead of relying on one keyword or database query, you generate several possible paths that are likely to produce relevant companies.

PRIMARY RESPONSIBILITIES

1. Receive the structured search package from Stage 1.
2. Ask yourself: "Where is the highest probability of finding companies that match?"
3. Generate hypotheses based on multiple reasoning categories:
   - Industry knowledge: Which industries commonly purchase this service?
   - Business growth: Rapidly growing companies often need new technology.
   - Hiring activity: Companies hiring security engineers may already recognize risks.
   - Technology adoption: Companies using cloud/tech stacks may have different needs.
   - Regulatory requirements: Businesses under compliance frameworks invest in security.
   - Company lifecycle: Startups, scale-ups, and enterprises face different challenges.
   - Historical performance: Which industries have converted well in the past?

4. For each hypothesis, provide:
   - Industry name
   - Confidence score (0.00 to 1.00)
   - Reasoning explanation (short, clear)
   - Signals that support the hypothesis (e.g., regulatory, growth, hiring, etc.)

5. Prioritize hypotheses with the highest expected value.
6. Return structured JSON only.

YOU MUST NOT:
- Search for leads (Stage 3 handles this).
- Enrich companies (Stage 5 handles this).
- Score or rank prospects (Stages 6-7 handle this).
- Save results (Stage 8 handles this).
- Learn from outcomes (Stage 9 handles this).
- Produce long explanations beyond the reasoning field.

OUTPUT FORMAT
Return valid JSON only, using this schema:
{
  "success": boolean,
  "confidence": number,
  "hypotheses": [
    {
      "industry": string,
      "confidence": number,
      "reasoning": string,
      "signals": string[]
    }
  ],
  "search_strategy": {
    "primary_hypotheses": string[],
    "secondary_hypotheses": string[]
  },
  "reasoning_summary": string
}

SIGNAL TYPES TO USE
- "regulatory" - Companies under strict compliance requirements
- "sensitive_data" - Companies handling sensitive customer information
- "high_risk" - Companies frequently targeted by cyberattacks
- "digital_first" - Companies with strong digital presence
- "cloud_infrastructure" - Companies using cloud-based systems
- "growth" - Rapidly growing/expanding companies
- "digitalization" - Companies undergoing digital transformation
- "critical_infrastructure" - Companies with national importance
- "hiring" - Companies actively recruiting security roles
- "enterprise" - Large, established enterprises

IMPORTANT
- Be consistent.
- Do not hallucinate industries.
- Do not output extra commentary.
- Do not explain your reasoning beyond the reasoning field.
- Always prefer safe, evidence-based hypotheses over speculative ones.
- If uncertain, include lower-confidence hypotheses with clear reasoning.`;

// ────────────────────────────────────────────────────────────────
// 5. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
        console.warn(`⛔ [Stage2] Non-retryable (${err.response.status}): ${err.message}`);
        return null;
      }
      console.warn(`⚠️ [Stage2] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
      if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 6. Generate Static Fallback Hypotheses (when API fails)
// ────────────────────────────────────────────────────────────────

function generateFallbackHypotheses(searchPackage) {
  const service = searchPackage.service_needed || 'cybersecurity';
  const industries = SERVICE_INDUSTRY_MAP[service.toLowerCase()] || SERVICE_INDUSTRY_MAP['cybersecurity'];
  
  const hypotheses = industries.slice(0, 8).map(industry => {
    const industryData = INDUSTRY_SIGNALS[industry] || { 
      reasoning: `Commonly requires ${service} services based on market analysis`,
      signals: ['general'],
      defaultConfidence: 0.60
    };
    
    return {
      industry: industry,
      confidence: industryData.defaultConfidence || 0.60,
      reasoning: industryData.reasoning || `Businesses in the ${industry} sector have demonstrated need for ${service} services.`,
      signals: industryData.signals || ['general']
    };
  });
  
  return {
    success: true,
    confidence: 0.75,
    hypotheses: hypotheses,
    search_strategy: {
      primary_hypotheses: hypotheses.slice(0, 4).map(h => h.industry),
      secondary_hypotheses: hypotheses.slice(4, 8).map(h => h.industry)
    },
    reasoning_summary: `Generated ${hypotheses.length} hypotheses for service: ${service} (fallback mode)`
  };
}

// ────────────────────────────────────────────────────────────────
// 7. Historical Performance Integration (optional)
// ────────────────────────────────────────────────────────────────

function applyHistoricalAdjustments(hypotheses, historicalData) {
  if (!historicalData || Object.keys(historicalData).length === 0) {
    return hypotheses;
  }
  
  // If we have historical reply rates or conversion data, adjust confidence
  return hypotheses.map(h => {
    const industryKey = h.industry.toLowerCase();
    if (historicalData[industryKey]) {
      const performance = historicalData[industryKey];
      // Adjust confidence up or down based on historical performance
      const adjustment = (performance.replyRate || 0.10) - 0.10; // baseline 10%
      h.confidence = Math.min(Math.max(h.confidence + (adjustment * 0.5), 0.20), 0.98);
      h.reasoning += ` Historical data shows ${(performance.replyRate * 100).toFixed(0)}% reply rate.`;
    }
    return h;
  });
}

// ────────────────────────────────────────────────────────────────
// 8. Main Stage 2 Function: Generate Search Hypotheses
// ────────────────────────────────────────────────────────────────

async function generateHypotheses({ 
  searchPackage, 
  apiKey, 
  userId = 'anonymous', 
  onProgress = null,
  historicalData = null
}) {
  console.log(`🧠 [Stage2] Generating hypotheses for user ${userId}...`);
  console.log(`📋 [Stage2] Search Package:`, JSON.stringify(searchPackage, null, 2));
  onProgress?.('🧠 Generating search hypotheses...');

  // ─── Validate input ───
  if (!searchPackage) {
    return {
      success: false,
      confidence: 0,
      hypotheses: [],
      search_strategy: { primary_hypotheses: [], secondary_hypotheses: [] },
      reasoning_summary: 'No search package provided to Stage 2.',
      error: 'MISSING_SEARCH_PACKAGE'
    };
  }

  const service = searchPackage.service_needed;
  const industries = searchPackage.industries || [];
  const countries = searchPackage.countries || ['Global'];
  const targetType = searchPackage.target_type || 'Companies';

  if (!service || service.trim().length === 0) {
    return {
      success: false,
      confidence: 0,
      hypotheses: [],
      search_strategy: { primary_hypotheses: [], secondary_hypotheses: [] },
      reasoning_summary: 'No service_needed specified. Cannot generate hypotheses without knowing what the user is selling.',
      error: 'MISSING_SERVICE'
    };
  }

  // ─── Try AI-powered hypothesis generation ───
  let result = null;
  let usedFallback = false;

  if (apiKey) {
    try {
      result = await callHypothesisModel(searchPackage, apiKey);
    } catch (error) {
      console.error(`❌ [Stage2] AI generation failed:`, error.message);
      usedFallback = true;
    }
  } else {
    console.warn(`⚠️ [Stage2] No API key provided, using fallback`);
    usedFallback = true;
  }

  // ─── Use fallback if AI fails ───
  if (!result || !result.success) {
    console.log(`🔄 [Stage2] Using fallback hypothesis generation...`);
    result = generateFallbackHypotheses(searchPackage);
    usedFallback = true;
  }

  // ─── Apply historical adjustments if available ───
  if (historicalData && result.hypotheses) {
    result.hypotheses = applyHistoricalAdjustments(result.hypotheses, historicalData);
  }

  // ─── Filter and sort hypotheses ───
  if (result.hypotheses) {
    // Remove any with confidence below threshold
    result.hypotheses = result.hypotheses
      .filter(h => h.confidence >= MIN_CONFIDENCE_THRESHOLD)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_HYPOTHESES);
  }

  // ─── Ensure we have at least some hypotheses ───
  if (!result.hypotheses || result.hypotheses.length === 0) {
    console.log(`🔄 [Stage2] No hypotheses generated, using emergency fallback...`);
    result = generateFallbackHypotheses(searchPackage);
  }

  // ─── Build search strategy ───
  const primary = result.hypotheses.slice(0, 5).map(h => h.industry);
  const secondary = result.hypotheses.slice(5, 10).map(h => h.industry);

  result.search_strategy = {
    primary_hypotheses: primary,
    secondary_hypotheses: secondary
  };

  // ─── Calculate overall confidence ───
  const avgConfidence = result.hypotheses.reduce((sum, h) => sum + h.confidence, 0) / result.hypotheses.length;
  result.confidence = Math.round((result.confidence || avgConfidence) * 100) / 100;

  // ─── Final logging ───
  console.log(`✅ [Stage2] Generated ${result.hypotheses.length} hypotheses`);
  console.log(`📊 [Stage2] Primary: ${primary.join(', ')}`);
  console.log(`📊 [Stage2] Secondary: ${secondary.join(', ')}`);
  console.log(`📊 [Stage2] Confidence: ${(result.confidence * 100).toFixed(1)}%`);

  result.success = true;
  result.used_fallback = usedFallback;
  result.userId = userId;

  return result;
}

// ────────────────────────────────────────────────────────────────
// 9. Model Call Helper
// ────────────────────────────────────────────────────────────────

async function callHypothesisModel(searchPackage, apiKey) {
  const userPrompt = `
SEARCH PACKAGE:
- Service Needed: ${searchPackage.service_needed || 'Not specified'}
- Industries: ${searchPackage.industries?.join(', ') || 'Not specified'}
- Countries: ${searchPackage.countries?.join(', ') || 'Global'}
- Target Type: ${searchPackage.target_type || 'Companies'}
- Requested Results: ${searchPackage.requested_results || 100}
- Language: ${searchPackage.language || 'English'}

FILTERS:
- Company Size: ${searchPackage.filters?.company_size || 'Any'}
- Employee Count: ${searchPackage.filters?.employee_count_min || 'Any'} to ${searchPackage.filters?.employee_count_max || 'Any'}
- Revenue: ${searchPackage.filters?.revenue_min || 'Any'} to ${searchPackage.filters?.revenue_max || 'Any'}
- Tech Stack: ${searchPackage.filters?.tech_stack?.join(', ') || 'Not specified'}
- Hiring Activity: ${searchPackage.filters?.hiring_activity || 'Not specified'}
- Job Titles: ${searchPackage.filters?.job_titles?.join(', ') || 'Not specified'}
- Business Type: ${searchPackage.filters?.business_type || 'Not specified'}

Based on this search package, generate 6-12 search hypotheses (industries and verticals) that are most likely to contain companies needing ${searchPackage.service_needed} services.

For each hypothesis, provide:
1. The industry name
2. A confidence score (0.00 to 1.00)
3. Reasoning (why this industry is likely)
4. Signal types that support this hypothesis

Return valid JSON only.`;

  const response = await withRetry(() => axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: HYPOTHESIS_MODEL,
      messages: [
        { role: 'system', content: HYPOTHESIS_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      response_format: { type: 'json_object' }
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  ), 'Stage2:Hypothesis');

  if (!response) {
    throw new Error('Hypothesis model call returned null');
  }

  const rawContent = response.data.choices[0].message.content.trim();
  const parsed = JSON.parse(rawContent);

  // Validate the response schema
  if (!parsed.hypotheses || !Array.isArray(parsed.hypotheses) || parsed.hypotheses.length === 0) {
    throw new Error('Invalid hypothesis schema: missing hypotheses array');
  }

  return parsed;
}

// ────────────────────────────────────────────────────────────────
// 10. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  generateHypotheses,
  INDUSTRY_SIGNALS,
  SERVICE_INDUSTRY_MAP,
  generateFallbackHypotheses,
  applyHistoricalAdjustments,
  MIN_CONFIDENCE_THRESHOLD,
  MAX_HYPOTHESES
};
