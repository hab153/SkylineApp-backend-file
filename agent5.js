'use strict';

/**
 * agent5.js – Stage 5: Company Intelligence & Data Enrichment Engine
 * 
 * The business intelligence engine of Skyline's Lead Intelligence System.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Receive normalized company profiles from Stage 4.
 * 2. For each company, discover additional business information.
 * 3. Enrich across multiple categories:
 *    - Company Identity (name, website, description, industry, founded)
 *    - Company Size (employees, size category, locations)
 *    - Business Activity (hiring, funding, expansions, partnerships)
 *    - Technology Profile (AWS, Azure, cloud, stack)
 *    - Hiring Intelligence (open positions, security roles, IT roles)
 *    - Business Presence (LinkedIn, social, contact info)
 *    - Estimated Scale (revenue range, market size)
 * 4. Merge information from multiple sources.
 * 5. Verify and resolve conflicts between sources.
 * 6. Track confidence for each attribute.
 * 7. Return enriched profiles for Stages 6-9.
 * 
 * YOU MUST NOT:
 * - Score or rank companies (Stages 6-7 handle this).
 * - Save to database (Stage 8 handles this).
 * - Learn from outcomes (Stage 9 handles this).
 * - Draft outreach messages (this is a later stage).
 * - Produce long explanations.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const ENRICHMENT_MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 1200;
const MAX_SEARCH_RESULTS_PER_QUERY = 5;
const MAX_QUERIES_PER_COMPANY = 4;
const ENRICHMENT_TIMEOUT_MS = 20000;
const MAX_COMPANIES_TO_ENRICH = 500;
const MAX_CONCURRENT_ENRICHMENTS = 3;

// ────────────────────────────────────────────────────────────────
// 2. Tavily Key Rotation (reuse from Stage 3)
// ────────────────────────────────────────────────────────────────

// Reuse the same key rotation system from agent3.js
const TAVILY_KEYS = [];
for (let i = 1; i <= 8; i++) {
  const key = process.env[`TAVILY_API_KEY${i}`];
  if (key) {
    TAVILY_KEYS.push(key);
  }
}

const DEFAULT_KEYS = ['dummy_key_1', 'dummy_key_2', 'dummy_key_3'];
const TAVILY_API_KEYS = TAVILY_KEYS.length > 0 ? TAVILY_KEYS : DEFAULT_KEYS;

let currentKeyIndex = 0;
let keyUsageCount = {};
let keyResetDate = new Date();

TAVILY_API_KEYS.forEach((_, index) => {
  keyUsageCount[index] = 0;
});

function getNextTavilyKey() {
  const now = new Date();
  const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
  
  if (keyResetDate < monthAgo) {
    console.log(`🔄 [Stage5] New month detected - resetting Tavily key usage counts`);
    TAVILY_API_KEYS.forEach((_, index) => {
      keyUsageCount[index] = 0;
    });
    keyResetDate = now;
    currentKeyIndex = 0;
  }

  const maxSearchesPerKey = 1000;
  const totalKeys = TAVILY_API_KEYS.length;
  
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const index = (currentKeyIndex + attempt) % totalKeys;
    if (keyUsageCount[index] < maxSearchesPerKey) {
      currentKeyIndex = index;
      keyUsageCount[index] = (keyUsageCount[index] || 0) + 1;
      return TAVILY_API_KEYS[index];
    }
  }

  // Reset all keys
  TAVILY_API_KEYS.forEach((_, index) => {
    keyUsageCount[index] = 0;
  });
  currentKeyIndex = 0;
  keyUsageCount[0] = 1;
  return TAVILY_API_KEYS[0];
}

function getTavilyUsageStats() {
  const stats = {};
  TAVILY_API_KEYS.forEach((_, index) => {
    stats[`key${index + 1}`] = {
      used: keyUsageCount[index] || 0,
      remaining: Math.max(0, 1000 - (keyUsageCount[index] || 0))
    };
  });
  return stats;
}

// ────────────────────────────────────────────────────────────────
// 3. Tavily Search Helper
// ────────────────────────────────────────────────────────────────

async function searchTavily(query, maxResults = MAX_SEARCH_RESULTS_PER_QUERY) {
  if (TAVILY_API_KEYS.length === 0 || TAVILY_API_KEYS[0] === 'dummy_key_1') {
    console.warn('⚠️ [Stage5] No valid Tavily API keys provided, returning mock data');
    return generateMockEnrichmentResults(query);
  }

  const apiKey = getNextTavilyKey();
  
  if (!apiKey) {
    console.warn('⚠️ [Stage5] No Tavily API key available');
    return [];
  }

  try {
    const response = await withRetry(() => axios.post(
      'https://api.tavily.com/search',
      {
        api_key: apiKey,
        query: query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    ), `Tavily:${query.slice(0, 40)}`);

    if (!response) return [];

    return (response.data?.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || '',
      date: r.published_date || null,
      source: 'tavily'
    }));

  } catch (error) {
    console.error(`❌ [Stage5] Tavily search failed:`, error.message);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// 4. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
        console.warn(`⛔ [Stage5] Non-retryable (${err.response.status}): ${err.message}`);
        return null;
      }
      console.warn(`⚠️ [Stage5] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
      if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 5. Mock Enrichment Data (for development)
// ────────────────────────────────────────────────────────────────

function generateMockEnrichmentResults(query) {
  const mockResults = [
    {
      title: 'About ABC Technologies',
      url: 'https://abctech.com/about',
      snippet: 'ABC Technologies is a leading healthcare software provider founded in 2016. We employ over 420 professionals across Berlin, Munich, and Hamburg. Our platform serves hospitals and clinics across Europe.'
    },
    {
      title: 'ABC Technologies - LinkedIn',
      url: 'https://linkedin.com/company/abctech',
      snippet: 'ABC Technologies | 420 employees | Healthcare | Berlin, Germany | 12 open positions including Senior Security Engineer, Cloud Architect, and DevOps Lead.'
    },
    {
      title: 'ABC Technologies raises €25M Series B',
      url: 'https://techcrunch.com/...',
      snippet: 'ABC Technologies, a Berlin-based healthcare software company, has raised €25 million in Series B funding. The company plans to expand into new European markets.'
    },
    {
      title: 'ABC Technologies Careers',
      url: 'https://abctech.com/careers',
      snippet: 'Join our team! We\'re hiring: Cloud Engineers, Security Analysts, Full Stack Developers, and Product Managers. We use AWS, Azure, Docker, and Kubernetes.'
    },
    {
      title: 'ABC Technologies - Healthcare IT',
      url: 'https://healthcareit.com/companies/abctech',
      snippet: 'ABC Technologies provides cloud-based electronic health record (EHR) and practice management solutions. Revenue estimated at €45-50M annually.'
    }
  ];
  
  // Filter by query keywords
  const keywords = query.toLowerCase().split(' ').filter(w => w.length > 3);
  const filtered = mockResults.filter(r => {
    const text = (r.title + ' ' + r.snippet).toLowerCase();
    return keywords.some(k => text.includes(k)) || keywords.length === 0;
  });
  
  return filtered.slice(0, MAX_SEARCH_RESULTS_PER_QUERY);
}

// ────────────────────────────────────────────────────────────────
// 6. Build Enrichment Queries for a Company
// ────────────────────────────────────────────────────────────────

function buildEnrichmentQueries(company) {
  const queries = [];
  const name = company.name || company.company || '';
  const domain = company.domain || company.website?.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || '';
  
  // 1. About / company overview
  if (name) {
    queries.push(`"${name}" company about overview`);
  }
  
  // 2. Team / employees
  if (name) {
    queries.push(`"${name}" team employees size`);
  }
  
  // 3. Technology stack
  if (name) {
    queries.push(`"${name}" technology stack cloud`);
  }
  
  // 4. Recent news / funding
  if (name) {
    queries.push(`"${name}" news funding expansion`);
  }
  
  // 5. Domain-specific searches (if domain available)
  if (domain) {
    queries.push(`site:${domain} about team careers`);
    queries.push(`site:${domain} technology cloud stack`);
  }
  
  // 6. LinkedIn
  if (name) {
    queries.push(`"${name}" LinkedIn employees`);
  }
  
  // Remove duplicates and limit
  return [...new Set(queries)].slice(0, MAX_QUERIES_PER_COMPANY);
}

// ────────────────────────────────────────────────────────────────
// 7. Extract Enrichment Data from Search Results
// ────────────────────────────────────────────────────────────────

function extractEnrichmentData(searchResults, company) {
  if (!searchResults || searchResults.length === 0) {
    return { enriched: company, found: 0 };
  }
  
  // Combine all text for analysis
  const allText = searchResults.map(r => `${r.title} ${r.snippet}`).join(' ');
  const allUrls = searchResults.map(r => r.url);
  
  // Extract structured data using regex patterns
  const enrichment = {
    name: company.name || company.company || null,
    company: company.company || company.name || null,
    domain: company.domain || null,
    website: company.website || null,
    location: company.location || null,
    industry: company.industry || null,
    description: company.description || null,
    employees: company.employees || null,
    founded: company.founded || null,
    hiring: company.hiring || null,
    tech_stack: company.tech_stack || [],
    sources: company.sources || [],
    confidence: company.confidence || 0.5
  };
  
  // Extract employee count
  const employeeRegex = /(\d+)\s*(?:employees|staff|people|workers)/i;
  const employeeMatch = allText.match(employeeRegex);
  if (employeeMatch && !enrichment.employees) {
    enrichment.employees = parseInt(employeeMatch[1]);
  }
  
  // Extract employee range
  const rangeRegex = /(\d+)\s*-\s*(\d+)\s*(?:employees|staff|people|workers)/i;
  const rangeMatch = allText.match(rangeRegex);
  if (rangeMatch && !enrichment.employees) {
    enrichment.employees = Math.floor((parseInt(rangeMatch[1]) + parseInt(rangeMatch[2])) / 2);
  }
  
  // Extract founded year
  const foundedRegex = /founded in\s*(\d{4})/i;
  const foundedMatch = allText.match(foundedRegex);
  if (foundedMatch && !enrichment.founded) {
    enrichment.founded = parseInt(foundedMatch[1]);
  }
  
  // Extract location (city, country)
  const locationMatches = allText.match(/(?:based in|headquartered in|located in|HQ:?\s*)([A-Z][a-z]+(?:,\s*[A-Z][a-z]+)?)/gi);
  if (locationMatches && !enrichment.location) {
    enrichment.location = locationMatches[0].replace(/(?:based in|headquartered in|located in|HQ:?\s*)/i, '').trim();
  }
  
  // Extract industry
  const industryKeywords = ['healthcare', 'fintech', 'saas', 'manufacturing', 'banking', 'insurance', 
                           'logistics', 'retail', 'education', 'energy', 'telecommunications', 'consulting'];
  if (!enrichment.industry) {
    for (const keyword of industryKeywords) {
      if (allText.toLowerCase().includes(keyword)) {
        enrichment.industry = keyword.charAt(0).toUpperCase() + keyword.slice(1);
        break;
      }
    }
  }
  
  // Extract hiring signals
  const hiringIndicators = ['hiring', 'careers', 'open position', 'job opening', 'we\'re hiring', 'join our team'];
  if (!enrichment.hiring) {
    const hasHiring = hiringIndicators.some(ind => allText.toLowerCase().includes(ind));
    if (hasHiring) {
      // Try to extract number of open positions
      const positionMatch = allText.match(/(\d+)\s*(?:open positions|jobs|hiring)/i);
      if (positionMatch) {
        enrichment.hiring = parseInt(positionMatch[1]);
      } else {
        enrichment.hiring = true;
      }
    }
  }
  
  // Extract tech stack
  const techKeywords = ['AWS', 'Azure', 'GCP', 'Google Cloud', 'Kubernetes', 'Docker', 'React', 
                       'Node.js', 'Python', 'Java', 'Go', 'Rust', 'PostgreSQL', 'MongoDB', 'Redis',
                       'Elasticsearch', 'Kafka', 'Spark', 'Hadoop', 'Terraform', 'Ansible'];
  if (!enrichment.tech_stack || enrichment.tech_stack.length === 0) {
    const foundTech = [];
    for (const tech of techKeywords) {
      if (allText.toLowerCase().includes(tech.toLowerCase())) {
        foundTech.push(tech);
      }
    }
    if (foundTech.length > 0) {
      enrichment.tech_stack = foundTech;
    }
  }
  
  // Extract LinkedIn URL
  const linkedinRegex = /https?:\/\/(?:www\.)?linkedin\.com\/company\/[^\s"']+/i;
  const linkedinMatch = allText.match(linkedinRegex);
  if (linkedinMatch) {
    enrichment.linkedin = linkedinMatch[0];
  }
  
  // Extract description (first meaningful sentence)
  if (!enrichment.description) {
    const sentences = allText.match(/[^.!?]+[.!?]/g) || [];
    for (const sentence of sentences) {
      if (sentence.length > 40 && sentence.length < 200) {
        const clean = sentence.replace(/[^a-zA-Z0-9\s.,]/g, '').trim();
        if (clean.length > 40) {
          enrichment.description = clean;
          break;
        }
      }
    }
  }
  
  // Count sources that contributed
  enrichment.sources = [...new Set([...(enrichment.sources || []), ...searchResults.map(r => r.source || 'tavily')])];
  
  // Calculate confidence boost based on how much we found
  const foundFields = [
    enrichment.employees,
    enrichment.location,
    enrichment.industry,
    enrichment.description,
    enrichment.founded,
    enrichment.hiring,
    enrichment.tech_stack?.length > 0
  ].filter(Boolean).length;
  
  const confidenceBoost = Math.min(foundFields / 7, 0.3);
  enrichment.confidence = Math.min((company.confidence || 0.5) + confidenceBoost, 0.98);
  
  return enrichment;
}

// ────────────────────────────────────────────────────────────────
// 8. Enrich a Single Company
// ────────────────────────────────────────────────────────────────

async function enrichSingleCompany(company, onProgress) {
  const name = company.name || company.company || '';
  if (!name) {
    console.warn(`⚠️ [Stage5] Cannot enrich company without name`);
    return {
      ...company,
      enrichment_attempted: false,
      enrichment_error: 'No company name provided'
    };
  }
  
  console.log(`🔍 [Stage5] Enriching: ${name}`);
  onProgress?.(`🔍 Enriching ${name}...`);
  
  // Build search queries
  const queries = buildEnrichmentQueries(company);
  console.log(`📋 [Stage5] Queries for ${name}:`, queries);
  
  // Execute searches
  let allResults = [];
  for (const query of queries) {
    const results = await searchTavily(query, MAX_SEARCH_RESULTS_PER_QUERY);
    if (results && results.length > 0) {
      allResults = allResults.concat(results);
    }
  }
  
  // Extract enrichment data
  const enriched = extractEnrichmentData(allResults, company);
  enriched.enrichment_attempted = true;
  enriched.enrichment_queries_used = queries.length;
  enriched.enrichment_sources_found = allResults.length;
  enriched.enrichment_timestamp = new Date().toISOString();
  
  // Track what was enriched
  const enrichedFields = [];
  if (enriched.employees && !company.employees) enrichedFields.push('employees');
  if (enriched.location && !company.location) enrichedFields.push('location');
  if (enriched.industry && !company.industry) enrichedFields.push('industry');
  if (enriched.description && !company.description) enrichedFields.push('description');
  if (enriched.founded && !company.founded) enrichedFields.push('founded');
  if (enriched.hiring && !company.hiring) enrichedFields.push('hiring');
  if (enriched.tech_stack?.length > 0 && !company.tech_stack?.length) enrichedFields.push('tech_stack');
  if (enriched.linkedin && !company.linkedin) enrichedFields.push('linkedin');
  
  enriched.enriched_fields = enrichedFields;
  
  console.log(`✅ [Stage5] Enriched ${name}: +${enrichedFields.length} fields (${enrichedFields.join(', ')})`);
  
  return enriched;
}

// ────────────────────────────────────────────────────────────────
// 9. Main Stage 5 Function: Enrich Companies
// ────────────────────────────────────────────────────────────────

async function enrichCompanies({ 
  companies, 
  searchPackage, 
  userId = 'anonymous', 
  onProgress = null,
  limit = MAX_COMPANIES_TO_ENRICH
}) {
  console.log(`📊 [Stage5] Starting company enrichment for user ${userId}...`);
  console.log(`📊 [Stage5] Received ${companies?.length || 0} companies from Stage 4`);
  onProgress?.('📊 Enriching company intelligence...');
  
  // ─── Validate input ───
  if (!companies || companies.length === 0) {
    return {
      success: false,
      error: 'No companies provided to Stage 5',
      companies: [],
      stats: {
        total_input: 0,
        enriched: 0,
        skipped: 0,
        failed: 0
      }
    };
  }
  
  // ─── Limit companies to enrich ───
  const companiesToEnrich = companies.slice(0, limit);
  const skipped = companies.length - companiesToEnrich.length;
  
  console.log(`📊 [Stage5] Enriching ${companiesToEnrich.length} companies (${skipped} skipped due to limit)`);
  
  // ─── Enrich companies (with concurrency limit) ───
  const enrichedCompanies = [];
  let enrichedCount = 0;
  let failedCount = 0;
  
  // Process in batches
  const batches = [];
  for (let i = 0; i < companiesToEnrich.length; i += MAX_CONCURRENT_ENRICHMENTS) {
    batches.push(companiesToEnrich.slice(i, i + MAX_CONCURRENT_ENRICHMENTS));
  }
  
  for (const batch of batches) {
    const batchPromises = batch.map(company => enrichSingleCompany(company, onProgress));
    const batchResults = await Promise.allSettled(batchPromises);
    
    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value) {
        enrichedCompanies.push(result.value);
        if (result.value.enrichment_fields?.length > 0) {
          enrichedCount++;
        }
      } else {
        // Failed enrichment - keep original company
        const company = batch[0] || { name: 'Unknown' };
        enrichedCompanies.push({
          ...company,
          enrichment_attempted: true,
          enrichment_error: result.reason?.message || 'Enrichment failed'
        });
        failedCount++;
      }
    }
  }
  
  // ─── Calculate stats ───
  const stats = {
    total_input: companies.length,
    enriched: enrichedCount,
    skipped: skipped + (companies.length - companiesToEnrich.length),
    failed: failedCount,
    tavily_usage: getTavilyUsageStats()
  };
  
  console.log(`✅ [Stage5] Enrichment complete: ${enrichedCount} enriched, ${failedCount} failed`);
  console.log(`📊 [Stage5] Stats:`, stats);
  
  return {
    success: true,
    companies: enrichedCompanies,
    stats: stats,
    userId: userId,
    search_package: searchPackage,
    timestamp: new Date().toISOString()
  };
}

// ────────────────────────────────────────────────────────────────
// 10. Helper: Get Enrichment Statistics
// ────────────────────────────────────────────────────────────────

function getEnrichmentStats(companies) {
  if (!companies || companies.length === 0) {
    return {
      total: 0,
      with_employees: 0,
      with_location: 0,
      with_industry: 0,
      with_description: 0,
      with_founded: 0,
      with_hiring: 0,
      with_tech_stack: 0,
      with_linkedin: 0,
      average_confidence: 0,
      total_fields_enriched: 0
    };
  }
  
  let withEmployees = 0, withLocation = 0, withIndustry = 0, withDescription = 0;
  let withFounded = 0, withHiring = 0, withTechStack = 0, withLinkedin = 0;
  let totalConfidence = 0;
  let totalEnrichedFields = 0;
  
  for (const company of companies) {
    if (company.employees) withEmployees++;
    if (company.location) withLocation++;
    if (company.industry) withIndustry++;
    if (company.description) withDescription++;
    if (company.founded) withFounded++;
    if (company.hiring) withHiring++;
    if (company.tech_stack?.length > 0) withTechStack++;
    if (company.linkedin) withLinkedin++;
    totalConfidence += company.confidence || 0;
    totalEnrichedFields += company.enriched_fields?.length || 0;
  }
  
  return {
    total: companies.length,
    with_employees: withEmployees,
    with_location: withLocation,
    with_industry: withIndustry,
    with_description: withDescription,
    with_founded: withFounded,
    with_hiring: withHiring,
    with_tech_stack: withTechStack,
    with_linkedin: withLinkedin,
    average_confidence: totalConfidence / companies.length,
    total_fields_enriched: totalEnrichedFields
  };
}

// ────────────────────────────────────────────────────────────────
// 11. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  enrichCompanies,
  enrichSingleCompany,
  buildEnrichmentQueries,
  extractEnrichmentData,
  searchTavily,
  getNextTavilyKey,
  getTavilyUsageStats,
  getEnrichmentStats,
  generateMockEnrichmentResults,
  MAX_COMPANIES_TO_ENRICH,
  MAX_CONCURRENT_ENRICHMENTS
};
