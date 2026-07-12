'use strict';

/**
 * agent3.js – Stage 3: Multi-Source Search & Retrieval Engine
 * 
 * The retrieval engine of Skyline's Lead Intelligence System.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Receive hypotheses from Stage 2 (industries/verticals to search).
 * 2. For each hypothesis, generate multiple search variations (query expansion).
 * 3. Execute searches across multiple sources (Tavily with API key rotation).
 * 4. Run searches in parallel where possible.
 * 5. Collect all candidate companies into a temporary pool.
 * 6. Track which hypothesis/source each candidate came from.
 * 7. Return raw candidate records for Stages 4-7.
 * 
 * YOU MUST NOT:
 * - Deduplicate companies (Stage 4 handles this).
 * - Enrich company profiles (Stage 5 handles this).
 * - Score or rank companies (Stages 6-7 handle this).
 * - Save to database (Stage 8 handles this).
 * - Learn from outcomes (Stage 9 handles this).
 * - Verify emails (this is handled in Stage 5).
 * - Produce long explanations.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

// Tavily API Keys (8 keys, 1k free searches each per month)
// These should be set in your .env file as:
// TAVILY_API_KEY1=your_key_1
// TAVILY_API_KEY2=your_key_2
// ... up to TAVILY_API_KEY8

const TAVILY_KEYS = [];
for (let i = 1; i <= 8; i++) {
  const key = process.env[`TAVILY_API_KEY${i}`];
  if (key) {
    TAVILY_KEYS.push(key);
  }
}

// Default key count if no env vars set (for development)
const DEFAULT_KEYS = ['dummy_key_1', 'dummy_key_2', 'dummy_key_3'];

const TAVILY_API_KEYS = TAVILY_KEYS.length > 0 ? TAVILY_KEYS : DEFAULT_KEYS;

// Search configuration
const MAX_RESULTS_PER_SEARCH = 10;
const MAX_SEARCHES_PER_HYPOTHESIS = 5;
const MAX_QUERIES_PER_HYPOTHESIS = 4;
const SEARCH_TIMEOUT_MS = 15000;
const MAX_CONCURRENT_SEARCHES = 5;
const MIN_CANDIDATES_PER_HYPOTHESIS = 20;
const MAX_CANDIDATES_TOTAL = 5000;

// Key rotation state (shared across all instances)
let currentKeyIndex = 0;
let keyUsageCount = {};
let keyResetDate = new Date();

// Initialize usage counts for each key
TAVILY_API_KEYS.forEach((key, index) => {
  keyUsageCount[index] = 0;
});

// ────────────────────────────────────────────────────────────────
// 2. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
        console.warn(`⛔ [Stage3] Non-retryable (${err.response.status}): ${err.message}`);
        return null;
      }
      console.warn(`⚠️ [Stage3] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
      if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 3. Tavily API Key Rotation
// ────────────────────────────────────────────────────────────────

/**
 * Gets the next Tavily API key with rotation.
 * Each key can handle 1000 searches per month (free tier).
 * When a key reaches 1000, move to the next one.
 * After all 8 keys reach 1000, reset and start over.
 */
function getNextTavilyKey() {
  const now = new Date();
  const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
  
  // Reset counts if it's a new month
  if (keyResetDate < monthAgo) {
    console.log(`🔄 [Stage3] New month detected - resetting Tavily key usage counts`);
    TAVILY_API_KEYS.forEach((_, index) => {
      keyUsageCount[index] = 0;
    });
    keyResetDate = now;
    currentKeyIndex = 0;
  }

  // Find the next key that hasn't reached 1000 searches
  const maxSearchesPerKey = 1000;
  const totalKeys = TAVILY_API_KEYS.length;
  
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const index = (currentKeyIndex + attempt) % totalKeys;
    if (keyUsageCount[index] < maxSearchesPerKey) {
      currentKeyIndex = index;
      keyUsageCount[index] = (keyUsageCount[index] || 0) + 1;
      console.log(`🔑 [Stage3] Using Tavily Key ${index + 1}/${totalKeys} (${keyUsageCount[index]}/${maxSearchesPerKey} searches used)`);
      return TAVILY_API_KEYS[index];
    }
  }

  // All keys have reached 1000 - reset all counts and start over
  console.log(`🔄 [Stage3] All Tavily keys exhausted (1000 each). Resetting...`);
  TAVILY_API_KEYS.forEach((_, index) => {
    keyUsageCount[index] = 0;
  });
  currentKeyIndex = 0;
  keyUsageCount[0] = 1;
  console.log(`🔑 [Stage3] Using Tavily Key 1 (reset, 1/${maxSearchesPerKey})`);
  return TAVILY_API_KEYS[0];
}

/**
 * Gets the current usage statistics for Tavily keys.
 */
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
// 4. Tavily Search Helper with Key Rotation
// ────────────────────────────────────────────────────────────────

async function searchTavily(query, maxResults = MAX_RESULTS_PER_SEARCH) {
  if (TAVILY_API_KEYS.length === 0 || TAVILY_API_KEYS[0] === 'dummy_key_1') {
    console.warn('⚠️ [Stage3] No valid Tavily API keys provided, returning mock data');
    return generateMockResults(query, maxResults);
  }

  const apiKey = getNextTavilyKey();
  
  if (!apiKey) {
    console.warn('⚠️ [Stage3] No Tavily API key available');
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
        timeout: SEARCH_TIMEOUT_MS
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
    console.error(`❌ [Stage3] Tavily search failed for "${query}":`, error.message);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// 5. Mock Search Results (for development without API keys)
// ────────────────────────────────────────────────────────────────

function generateMockResults(query, maxResults) {
  const mockCompanies = [
    { title: 'ABC Healthcare GmbH', url: 'https://abchealthcare.de', snippet: 'Leading healthcare provider in Germany specializing in digital health solutions.' },
    { title: 'Deutsche Bank AG', url: 'https://deutsche-bank.de', snippet: 'One of Germany\'s largest financial institutions offering comprehensive banking services.' },
    { title: 'SAP SE', url: 'https://sap.com', snippet: 'Global enterprise software company headquartered in Germany, specializing in cloud solutions.' },
    { title: 'Siemens Healthineers', url: 'https://siemens-healthineers.com', snippet: 'Medical technology company focused on diagnostic imaging and healthcare IT.' },
    { title: 'Klarna', url: 'https://klarna.com', snippet: 'Fintech company providing buy now pay later services and online payment solutions.' },
    { title: 'Helios Kliniken', url: 'https://helios-gesundheit.de', snippet: 'One of Europe\'s largest hospital operators with extensive healthcare services.' },
    { title: 'Commerzbank', url: 'https://commerzbank.de', snippet: 'Major German bank with extensive corporate and investment banking operations.' },
    { title: 'Zalando', url: 'https://zalando.de', snippet: 'Europe\'s leading online fashion platform with advanced e-commerce technology.' },
    { title: 'Delivery Hero', url: 'https://deliveryhero.com', snippet: 'Global food delivery platform with extensive logistics and technology infrastructure.' },
    { title: 'N26', url: 'https://n26.com', snippet: 'Digital bank offering mobile banking services across Europe.' },
    { title: 'Axa Germany', url: 'https://axa.de', snippet: 'Major insurance company with extensive digital transformation initiatives.' },
    { title: 'DHL Group', url: 'https://dhl.com', snippet: 'Global logistics provider with advanced supply chain technology and digital services.' },
    { title: 'E.ON', url: 'https://eon.com', snippet: 'Energy company with significant investments in renewable energy and smart grid technology.' },
    { title: 'Deutsche Telekom', url: 'https://telekom.de', snippet: 'Major telecommunications provider with extensive enterprise services.' },
    { title: 'Bayer AG', url: 'https://bayer.com', snippet: 'Pharmaceutical and life sciences company with advanced research and digital health initiatives.' },
  ];
  
  // Filter by query keywords
  const keywords = query.toLowerCase().split(' ').filter(w => w.length > 3);
  const filtered = mockCompanies.filter(c => {
    const text = (c.title + ' ' + c.snippet).toLowerCase();
    return keywords.some(k => text.includes(k)) || keywords.length === 0;
  });
  
  return filtered.slice(0, maxResults);
}

// ────────────────────────────────────────────────────────────────
// 6. Query Expansion for Each Hypothesis
// ────────────────────────────────────────────────────────────────

function expandQuery(industry, location, service, targetType) {
  const queries = [];
  const country = location || 'Germany';
  
  // Base query variations
  const baseQueries = [
    `${industry} companies ${country}`,
    `${industry} businesses ${country}`,
    `${industry} startups ${country}`,
    `top ${industry} companies ${country}`,
    `leading ${industry} firms ${country}`,
  ];
  
  // Add location-specific variations
  if (location) {
    baseQueries.push(`${industry} companies in ${location}`);
    baseQueries.push(`${industry} ${location} list`);
    baseQueries.push(`${industry} ${location} directory`);
  }
  
  // Add service-specific variations (if provided)
  if (service) {
    baseQueries.push(`${industry} companies using ${service}`);
    baseQueries.push(`${industry} ${service} solutions ${country}`);
    baseQueries.push(`${industry} ${service} providers ${country}`);
  }
  
  // Add target type variations
  if (targetType === 'Startups') {
    baseQueries.push(`${industry} startups ${country}`);
    baseQueries.push(`${industry} early stage ${country}`);
  } else if (targetType === 'SME') {
    baseQueries.push(`${industry} SMEs ${country}`);
    baseQueries.push(`${industry} mid-size companies ${country}`);
  } else if (targetType === 'Enterprise') {
    baseQueries.push(`${industry} enterprises ${country}`);
    baseQueries.push(`${industry} large companies ${country}`);
  }
  
  // Add diversity queries (about/team pages for real contacts)
  baseQueries.push(`${industry} ${country} about us team`);
  baseQueries.push(`${industry} ${country} contact us`);
  
  // Remove duplicates and limit
  return [...new Set(baseQueries)].slice(0, MAX_QUERIES_PER_HYPOTHESIS);
}

// ────────────────────────────────────────────────────────────────
// 7. Execute a Single Hypothesis Search
// ────────────────────────────────────────────────────────────────

async function executeHypothesisSearch(hypothesis, searchPackage, onProgress) {
  const { industry, confidence } = hypothesis;
  const location = searchPackage.countries?.[0] || 'Global';
  const service = searchPackage.service_needed || null;
  const targetType = searchPackage.target_type || 'Companies';
  
  console.log(`🔍 [Stage3] Executing hypothesis: ${industry} (confidence: ${confidence})`);
  onProgress?.(`🔎 Searching ${industry}...`);
  
  // Generate expanded queries for this hypothesis
  const queries = expandQuery(industry, location, service, targetType);
  console.log(`📋 [Stage3] Queries for ${industry}:`, queries);
  
  // Execute searches in parallel (with concurrency limit)
  const searchPromises = queries.map(query => searchTavily(query, MAX_RESULTS_PER_SEARCH));
  const results = await Promise.all(searchPromises);
  
  // Flatten results
  let allResults = [];
  results.forEach((result, index) => {
    if (result && result.length > 0) {
      const query = queries[index] || 'unknown';
      allResults = allResults.concat(
        result.map(r => ({
          ...r,
          query: query,
          industry: industry,
          hypothesis_confidence: confidence
        }))
      );
    }
  });
  
  // Remove duplicates from this hypothesis (by URL)
  const seenUrls = new Set();
  const uniqueResults = allResults.filter(r => {
    if (seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return true;
  });
  
  console.log(`✅ [Stage3] ${industry}: Found ${uniqueResults.length} unique results from ${queries.length} queries`);
  
  return {
    hypothesis: industry,
    confidence: confidence,
    queries_used: queries,
    results: uniqueResults,
    total_found: uniqueResults.length
  };
}

// ────────────────────────────────────────────────────────────────
// 8. Extract Companies from Search Results
// ────────────────────────────────────────────────────────────────

function extractCompaniesFromResults(searchResults, source) {
  if (!searchResults || searchResults.length === 0) return [];
  
  const companies = [];
  const seenDomains = new Set();
  
  for (const result of searchResults) {
    // Extract domain from URL
    let domain = null;
    try {
      const urlObj = new URL(result.url);
      domain = urlObj.hostname.replace('www.', '');
    } catch {
      // Skip invalid URLs
    }
    
    if (!domain) continue;
    
    // Skip known non-company domains
    const skipDomains = ['youtube.com', 'twitter.com', 'linkedin.com', 'facebook.com', 
                        'instagram.com', 'reddit.com', 'medium.com', 'wikipedia.org',
                        'getprospect.com', 'apollo.io', 'zoominfo.com', 'crunchbase.com',
                        'github.com', 'glassdoor.com', 'indeed.com', 'xing.com', 'personio.de'];
    if (skipDomains.some(skip => domain.includes(skip))) continue;
    
    // Deduplicate by domain
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    
    // Extract company name from title or domain
    let name = result.title || domain;
    // Clean up title
    name = name
      .replace(/\s*[|\-–].*$/, '') // Remove trailing separators
      .replace(/\s*•\s*.*$/, '')    // Remove bullet points
      .replace(/\b(Ltd|LLC|Inc|Limited|PLC|Corp|Corporation|GmbH|AG)\b/gi, '')
      .trim();
    
    if (name.length < 2) name = domain.split('.')[0];
    
    companies.push({
      name: name,
      domain: domain,
      website: result.url,
      source: source || 'tavily',
      source_url: result.url,
      snippet: result.snippet || '',
      industry: result.industry || null,
      hypothesis_confidence: result.hypothesis_confidence || 0.5,
      query: result.query || null,
      date: result.date || null,
      raw_title: result.title || null
    });
  }
  
  return companies;
}

// ────────────────────────────────────────────────────────────────
// 9. Main Stage 3 Function: Multi-Source Search
// ────────────────────────────────────────────────────────────────

async function multiSourceSearch({ 
  hypotheses, 
  searchPackage, 
  userId = 'anonymous', 
  onProgress = null,
  sources = ['tavily'] // Can be extended for multiple sources
}) {
  console.log(`🔍 [Stage3] Starting multi-source search for user ${userId}...`);
  console.log(`📋 [Stage3] Hypotheses:`, hypotheses.map(h => h.industry).join(', '));
  console.log(`📋 [Stage3] Search Package:`, JSON.stringify(searchPackage, null, 2));
  onProgress?.('🔎 Searching multiple sources...');

  // ─── Validate input ───
  if (!hypotheses || hypotheses.length === 0) {
    return {
      success: false,
      error: 'No hypotheses provided to Stage 3',
      candidates: [],
      stats: { searched: 0, found: 0, returned: 0, hypotheses: 0 }
    };
  }

  // ─── Execute searches for each hypothesis (in parallel with concurrency limit) ───
  const startTime = Date.now();
  let allResults = [];
  let hypothesisResults = [];
  let totalSearches = 0;

  // Sort hypotheses by confidence (highest first)
  const sortedHypotheses = [...hypotheses].sort((a, b) => b.confidence - a.confidence);

  // Execute with concurrency limit
  const chunks = [];
  for (let i = 0; i < sortedHypotheses.length; i += MAX_CONCURRENT_SEARCHES) {
    chunks.push(sortedHypotheses.slice(i, i + MAX_CONCURRENT_SEARCHES));
  }

  for (const chunk of chunks) {
    const chunkPromises = chunk.map(h => 
      executeHypothesisSearch(h, searchPackage, onProgress)
    );
    const chunkResults = await Promise.all(chunkPromises);
    chunkResults.forEach(r => {
      if (r && r.results) {
        hypothesisResults.push(r);
        allResults = allResults.concat(r.results);
        totalSearches += r.queries_used?.length || 0;
      }
    });
  }

  // ─── Extract companies from results ───
  console.log(`📊 [Stage3] Found ${allResults.length} raw results from ${hypothesisResults.length} hypotheses`);
  onProgress?.('📋 Extracting companies...');

  let allCompanies = [];
  for (const source of sources) {
    const companies = extractCompaniesFromResults(allResults, source);
    allCompanies = allCompanies.concat(companies);
  }

  // ─── Apply total limit ───
  const limit = Math.min(searchPackage.requested_results * 3 || 500, MAX_CANDIDATES_TOTAL);
  const limitedCompanies = allCompanies.slice(0, limit);

  // ─── Calculate stats ───
  const endTime = Date.now();
  const duration = endTime - startTime;

  const stats = {
    searched: totalSearches,
    found: allResults.length,
    returned: limitedCompanies.length,
    hypotheses: hypothesisResults.length,
    duration_ms: duration,
    sources: sources,
    tavily_usage: getTavilyUsageStats()
  };

  console.log(`✅ [Stage3] Search complete: ${limitedCompanies.length} candidates found from ${hypothesisResults.length} hypotheses`);
  console.log(`📊 [Stage3] Stats:`, stats);

  return {
    success: true,
    candidates: limitedCompanies,
    hypothesis_results: hypothesisResults,
    stats: stats,
    userId: userId,
    search_package: searchPackage
  };
}

// ────────────────────────────────────────────────────────────────
// 10. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  multiSourceSearch,
  searchTavily,
  getNextTavilyKey,
  getTavilyUsageStats,
  expandQuery,
  executeHypothesisSearch,
  extractCompaniesFromResults,
  generateMockResults,
  TAVILY_API_KEYS,
  MAX_RESULTS_PER_SEARCH,
  MAX_QUERIES_PER_HYPOTHESIS,
  MAX_CONCURRENT_SEARCHES,
  MAX_CANDIDATES_TOTAL
};
