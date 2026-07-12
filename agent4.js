'use strict';

/**
 * agent4.js – Stage 4: Data Normalization & Entity Resolution Engine
 * 
 * The data quality engine of Skyline's Lead Intelligence System.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Standardize all company records (names, domains, locations, etc.)
 * 2. Detect duplicate records using fuzzy matching.
 * 3. Resolve entities by merging duplicates into unified profiles.
 * 4. Merge attributes from multiple sources (richer than any single source).
 * 5. Track confidence scores for each merge.
 * 6. Clean low-quality records (missing names, invalid domains, etc.)
 * 7. Return a clean, deduplicated dataset for Stages 5-9.
 * 
 * YOU MUST NOT:
 * - Enrich companies (Stage 5 handles this).
 * - Score or rank companies (Stages 6-7 handle this).
 * - Save to database (Stage 8 handles this).
 * - Learn from outcomes (Stage 9 handles this).
 * - Qualify or personalize leads (these are later stages).
 */

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const MIN_NAME_LENGTH = 2;
const MIN_DOMAIN_LENGTH = 4;
const FUZZY_MATCH_THRESHOLD = 0.75;
const HIGH_CONFIDENCE_THRESHOLD = 0.90;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.70;
const MAX_CANDIDATES_AFTER_DEDUPE = 3000;

// ────────────────────────────────────────────────────────────────
// 2. Utility: String Similarity (Levenshtein-based)
// ────────────────────────────────────────────────────────────────

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  const aClean = a.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const bClean = b.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  if (aClean === bClean) return 1;
  if (aClean.length === 0 || bClean.length === 0) return 0;
  const distance = levenshteinDistance(aClean, bClean);
  return 1 - (distance / Math.max(aClean.length, bClean.length));
}

// ────────────────────────────────────────────────────────────────
// 3. Utility: Domain Extraction
// ────────────────────────────────────────────────────────────────

function extractDomain(url) {
  if (!url) return null;
  try {
    // Handle URLs with protocols
    let domain = url;
    if (domain.includes('://')) {
      domain = domain.split('://')[1];
    }
    // Remove path, query, hash
    domain = domain.split('/')[0];
    domain = domain.split('?')[0];
    domain = domain.split('#')[0];
    // Remove www prefix
    domain = domain.replace(/^www\./, '');
    return domain.toLowerCase();
  } catch {
    return null;
  }
}

function getBaseDomain(domain) {
  if (!domain) return null;
  const parts = domain.split('.');
  if (parts.length >= 2) {
    // Handle country TLDs (co.uk, com.au, etc.)
    if (parts.length >= 3 && parts[parts.length - 2].length <= 3) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  }
  return domain;
}

// ────────────────────────────────────────────────────────────────
// 4. Utility: Normalize Company Name
// ────────────────────────────────────────────────────────────────

function normalizeCompanyName(name) {
  if (!name) return null;
  
  let normalized = name
    .replace(/\s+/g, ' ')
    .trim()
    // Remove common suffixes
    .replace(/\b(GmbH|AG|LLC|Inc|Limited|Ltd|Corp|Corporation|PLC|S.A|S.p.A|AB|OY|AS|ApS|SRL|BV|NV|B.V|N.V)\b/gi, '')
    // Remove legal entity indicators
    .replace(/\b(LLP|LP|LLC|PLLC|PC|PA|P.A|C.A|S.A.S|SAS|SARL|SRL)\b/gi, '')
    // Remove "The" prefix
    .replace(/^The\s+/i, '')
    // Remove "and" / "&" patterns
    .replace(/\s+and\s+/gi, ' ')
    .replace(/\s+&\s+/gi, ' ')
    // Remove special characters
    .replace(/[^a-zA-Z0-9\s\-]/g, '')
    // Normalize multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
  
  // If result is empty, return original cleaned
  if (normalized.length < MIN_NAME_LENGTH) {
    normalized = name
      .replace(/[^a-zA-Z0-9\s\-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  return normalized;
}

// ────────────────────────────────────────────────────────────────
// 5. Utility: Normalize Location
// ────────────────────────────────────────────────────────────────

function normalizeLocation(location) {
  if (!location) return null;
  
  let normalized = location
    .replace(/\s+/g, ' ')
    .trim()
    // Remove common prefixes
    .replace(/^(in|from|based in|near|located in)\s+/i, '')
    // Normalize country names
    .replace(/\b(Germany|DE|Deutschland)\b/i, 'Germany')
    .replace(/\b(United States|USA|US|United States of America)\b/i, 'United States')
    .replace(/\b(United Kingdom|UK|Great Britain|GB)\b/i, 'United Kingdom')
    .replace(/\b(France|FR|République française)\b/i, 'France')
    .replace(/\b(Italy|IT|Repubblica Italiana)\b/i, 'Italy')
    .replace(/\b(Spain|ES|Reino de España)\b/i, 'Spain')
    .replace(/\b(Netherlands|NL|Holland)\b/i, 'Netherlands')
    .replace(/\b(Switzerland|CH|Suisse)\b/i, 'Switzerland')
    .replace(/\b(Austria|AT|Österreich)\b/i, 'Austria')
    .replace(/\b(Sweden|SE|Sverige)\b/i, 'Sweden')
    .replace(/\b(Norway|NO|Norge)\b/i, 'Norway')
    .replace(/\b(Denmark|DK|Danmark)\b/i, 'Denmark')
    .replace(/\b(Finland|FI|Suomi)\b/i, 'Finland')
    .replace(/\b(Ireland|IE|Éire)\b/i, 'Ireland')
    .replace(/\b(Portugal|PT|República Portuguesa)\b/i, 'Portugal')
    .replace(/\b(Greece|GR|Ελλάδα)\b/i, 'Greece')
    .replace(/\b(Poland|PL|Polska)\b/i, 'Poland')
    .replace(/\b(Czech Republic|CZ|Česko)\b/i, 'Czech Republic')
    .replace(/\b(Canada|CA)\b/i, 'Canada')
    .replace(/\b(Australia|AU)\b/i, 'Australia')
    .replace(/\b(Japan|JP|日本)\b/i, 'Japan')
    .replace(/\b(China|CN|中国)\b/i, 'China')
    .replace(/\b(India|IN)\b/i, 'India')
    .replace(/\b(Brazil|BR|Brasil)\b/i, 'Brazil')
    .replace(/\b(Mexico|MX|México)\b/i, 'Mexico')
    .trim();
  
  return normalized || null;
}

// ────────────────────────────────────────────────────────────────
// 6. Utility: Clean Candidate Record
// ────────────────────────────────────────────────────────────────

function cleanCandidate(candidate) {
  if (!candidate) return null;
  
  // Extract and normalize fields
  const name = normalizeCompanyName(candidate.name || candidate.company || candidate.title || null);
  const domain = extractDomain(candidate.domain || candidate.website || candidate.source_url || candidate.url || null);
  const baseDomain = domain ? getBaseDomain(domain) : null;
  const location = normalizeLocation(candidate.location || null);
  const website = candidate.website || candidate.source_url || candidate.url || null;
  
  // If no name and no domain, this is useless
  if (!name && !domain) {
    return null;
  }
  
  // Use domain as name if no name exists
  const finalName = name || (domain ? domain.split('.')[0] : null);
  
  return {
    original: candidate,
    name: finalName,
    company: candidate.company || finalName,
    domain: domain,
    baseDomain: baseDomain,
    website: website,
    location: location,
    industry: candidate.industry || null,
    description: candidate.snippet || candidate.description || null,
    source: candidate.source || 'unknown',
    source_url: candidate.source_url || candidate.url || null,
    confidence: candidate.confidence || candidate.fit_score || candidate.hypothesis_confidence || 0.5,
    signals: candidate.signals || [],
    metadata: {
      raw_title: candidate.raw_title || candidate.title || null,
      raw_snippet: candidate.snippet || null,
      query: candidate.query || null,
      date: candidate.date || null,
      hypothesis_confidence: candidate.hypothesis_confidence || null
    }
  };
}

// ────────────────────────────────────────────────────────────────
// 7. Core Function: Detect Duplicate Companies
// ────────────────────────────────────────────────────────────────

function findDuplicates(companyA, companyB) {
  // If either is null, no match
  if (!companyA || !companyB) return { isDuplicate: false, confidence: 0, reasons: [] };
  
  const reasons = [];
  let maxConfidence = 0;
  
  // 1. Domain match (highest confidence)
  if (companyA.domain && companyB.domain) {
    const similarity = stringSimilarity(companyA.domain, companyB.domain);
    if (similarity >= 0.95) {
      reasons.push('Domain matches exactly or near-exactly');
      maxConfidence = Math.max(maxConfidence, 0.98);
    } else if (similarity >= 0.85) {
      const baseA = getBaseDomain(companyA.domain);
      const baseB = getBaseDomain(companyB.domain);
      if (baseA === baseB) {
        reasons.push('Base domain matches');
        maxConfidence = Math.max(maxConfidence, 0.92);
      }
    }
  }
  
  // 2. Website URL match
  if (companyA.website && companyB.website) {
    const sim = stringSimilarity(companyA.website, companyB.website);
    if (sim >= 0.90) {
      reasons.push('Website URLs match');
      maxConfidence = Math.max(maxConfidence, 0.95);
    }
  }
  
  // 3. Company name similarity
  if (companyA.name && companyB.name) {
    const sim = stringSimilarity(companyA.name, companyB.name);
    if (sim >= FUZZY_MATCH_THRESHOLD) {
      reasons.push(`Company names are ${Math.round(sim * 100)}% similar`);
      maxConfidence = Math.max(maxConfidence, sim * 0.9);
    }
    // Check for partial matches (e.g., "ABC" in "ABC Technologies")
    const nameA = companyA.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameB = companyB.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nameA.includes(nameB) || nameB.includes(nameA)) {
      reasons.push('Company name contains the other');
      maxConfidence = Math.max(maxConfidence, 0.85);
    }
  }
  
  // 4. Location match
  if (companyA.location && companyB.location) {
    const sim = stringSimilarity(companyA.location, companyB.location);
    if (sim >= 0.70) {
      reasons.push('Locations match');
      maxConfidence = Math.max(maxConfidence, 0.75);
    }
  }
  
  // 5. Industry match
  if (companyA.industry && companyB.industry) {
    const sim = stringSimilarity(companyA.industry, companyB.industry);
    if (sim >= 0.60) {
      reasons.push('Industries match');
      maxConfidence = Math.max(maxConfidence, 0.70);
    }
  }
  
  // Determine if duplicate based on confidence
  const isDuplicate = maxConfidence >= FUZZY_MATCH_THRESHOLD;
  
  return {
    isDuplicate,
    confidence: Math.min(maxConfidence, 1.0),
    reasons: reasons
  };
}

// ────────────────────────────────────────────────────────────────
// 8. Core Function: Merge Duplicate Records
// ────────────────────────────────────────────────────────────────

function mergeRecords(records, matchConfidence) {
  if (!records || records.length === 0) return null;
  if (records.length === 1) return records[0];
  
  // Start with the first record as base
  const base = { ...records[0] };
  const sources = new Set([base.source]);
  const allSignals = new Set(base.signals || []);
  const allMetadata = [];
  
  // Track which fields were merged from where
  const mergedFrom = {
    name: [base.name],
    domain: [base.domain],
    website: [base.website],
    location: [base.location],
    industry: [base.industry],
    description: [base.description],
    confidence: [base.confidence]
  };
  
  // Merge other records
  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    
    // Track source
    if (record.source) sources.add(record.source);
    if (record.signals) {
      record.signals.forEach(s => allSignals.add(s));
    }
    if (record.metadata) {
      allMetadata.push(record.metadata);
    }
    
    // Merge name (prefer longer/more complete)
    if (record.name && record.name.length > base.name.length) {
      mergedFrom.name.push(record.name);
      base.name = record.name;
    } else if (record.name) {
      mergedFrom.name.push(record.name);
    }
    
    // Merge company
    if (record.company && !base.company) {
      base.company = record.company;
    } else if (record.company && record.company.length > (base.company || '').length) {
      base.company = record.company;
    }
    
    // Merge domain (prefer base domain)
    if (record.domain && !base.domain) {
      mergedFrom.domain.push(record.domain);
      base.domain = record.domain;
      base.baseDomain = getBaseDomain(record.domain);
    } else if (record.domain) {
      mergedFrom.domain.push(record.domain);
    }
    
    // Merge website (prefer official-looking)
    if (record.website && !base.website) {
      mergedFrom.website.push(record.website);
      base.website = record.website;
    } else if (record.website) {
      mergedFrom.website.push(record.website);
    }
    
    // Merge location (prefer more specific)
    if (record.location && (!base.location || record.location.length > base.location.length)) {
      mergedFrom.location.push(record.location);
      base.location = record.location;
    } else if (record.location) {
      mergedFrom.location.push(record.location);
    }
    
    // Merge industry
    if (record.industry && !base.industry) {
      mergedFrom.industry.push(record.industry);
      base.industry = record.industry;
    } else if (record.industry && record.industry !== base.industry) {
      mergedFrom.industry.push(record.industry);
      // If multiple industries, keep the most common or first
      if (base.industry && record.industry !== base.industry) {
        // Don't override, just collect
      }
    }
    
    // Merge description (prefer longer/more detailed)
    if (record.description && (!base.description || record.description.length > base.description.length)) {
      mergedFrom.description.push(record.description);
      base.description = record.description;
    } else if (record.description) {
      mergedFrom.description.push(record.description);
    }
    
    // Merge confidence (take max)
    if (record.confidence > base.confidence) {
      base.confidence = record.confidence;
    }
    mergedFrom.confidence.push(record.confidence);
    
    // Merge source_url (keep all)
    if (record.source_url && !base.source_url) {
      base.source_url = record.source_url;
    }
  }
  
  // Set merged fields
  base.sources = Array.from(sources);
  base.signals = Array.from(allSignals);
  base.metadata = allMetadata;
  base.mergedFrom = mergedFrom;
  base.matchConfidence = matchConfidence;
  base.mergedCount = records.length;
  base.isMerged = records.length > 1;
  
  return base;
}

// ────────────────────────────────────────────────────────────────
// 9. Core Function: Deduplicate and Normalize Candidates
// ────────────────────────────────────────────────────────────────

function deduplicateCandidates(candidates) {
  console.log(`📊 [Stage4] Starting deduplication with ${candidates.length} candidates...`);
  
  // Step 1: Clean all candidates
  const cleaned = [];
  const invalidReasons = [];
  
  for (const candidate of candidates) {
    const cleanedRecord = cleanCandidate(candidate);
    if (!cleanedRecord) {
      invalidReasons.push('Missing name and domain');
      continue;
    }
    if (!cleanedRecord.name || cleanedRecord.name.length < MIN_NAME_LENGTH) {
      invalidReasons.push('Name too short or invalid');
      continue;
    }
    cleaned.push(cleanedRecord);
  }
  
  console.log(`🧹 [Stage4] Cleaned: ${cleaned.length} valid candidates (${candidates.length - cleaned.length} removed)`);
  
  if (cleaned.length === 0) {
    return {
      success: true,
      companies: [],
      stats: {
        total_input: candidates.length,
        cleaned: 0,
        invalid_removed: candidates.length,
        duplicates_merged: 0,
        final_companies: 0
      }
    };
  }
  
  // Step 2: Group by domain first (fast path)
  const domainGroups = new Map();
  const noDomain = [];
  
  for (const record of cleaned) {
    if (record.baseDomain) {
      if (!domainGroups.has(record.baseDomain)) {
        domainGroups.set(record.baseDomain, []);
      }
      domainGroups.get(record.baseDomain).push(record);
    } else {
      noDomain.push(record);
    }
  }
  
  console.log(`📂 [Stage4] Grouped by domain: ${domainGroups.size} domains + ${noDomain.length} without domain`);
  
  // Step 3: Process each domain group (merge exact domain matches)
  const mergedByDomain = [];
  const processedDomains = new Set();
  
  for (const [domain, records] of domainGroups) {
    if (records.length === 1) {
      mergedByDomain.push(records[0]);
    } else {
      // Multiple records with same base domain - merge them
      const merged = mergeRecords(records, 0.95);
      if (merged) {
        mergedByDomain.push(merged);
      } else {
        // Fallback: take the first
        mergedByDomain.push(records[0]);
      }
    }
    processedDomains.add(domain);
  }
  
  // Step 4: Process no-domain records separately (they'll be matched by name)
  const candidatesToMatch = [...mergedByDomain, ...noDomain];
  
  // Step 5: Fuzzy match remaining candidates
  const finalCompanies = [];
  const matchedIndices = new Set();
  
  for (let i = 0; i < candidatesToMatch.length; i++) {
    if (matchedIndices.has(i)) continue;
    
    const current = candidatesToMatch[i];
    const matches = [current];
    
    // Find all similar records
    for (let j = i + 1; j < candidatesToMatch.length; j++) {
      if (matchedIndices.has(j)) continue;
      
      const other = candidatesToMatch[j];
      const result = findDuplicates(current, other);
      
      if (result.isDuplicate) {
        matches.push(other);
        matchedIndices.add(j);
      }
    }
    
    // If multiple matches, merge them
    if (matches.length > 1) {
      const merged = mergeRecords(matches, 0.85);
      if (merged) {
        finalCompanies.push(merged);
      } else {
        // Fallback: push first match
        finalCompanies.push(matches[0]);
      }
    } else {
      finalCompanies.push(current);
    }
    
    matchedIndices.add(i);
  }
  
  // Step 6: Clean up merged records
  const cleanedCompanies = finalCompanies.map(company => {
    // Remove mergedFrom metadata (internal)
    const { mergedFrom, metadata, original, ...clean } = company;
    return clean;
  });
  
  // Step 7: Sort by confidence (highest first) and limit
  const sorted = cleanedCompanies.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const limited = sorted.slice(0, MAX_CANDIDATES_AFTER_DEDUPE);
  
  console.log(`✅ [Stage4] Deduplication complete: ${limited.length} unique companies`);
  console.log(`📊 [Stage4] Removed ${candidates.length - limited.length} duplicates/invalid records`);
  
  return {
    success: true,
    companies: limited,
    stats: {
      total_input: candidates.length,
      cleaned: cleaned.length,
      invalid_removed: candidates.length - cleaned.length,
      duplicates_merged: cleaned.length - limited.length,
      final_companies: limited.length,
      domains_processed: processedDomains.size,
      no_domain: noDomain.length
    }
  };
}

// ────────────────────────────────────────────────────────────────
// 10. Main Stage 4 Function: Normalize & Deduplicate
// ────────────────────────────────────────────────────────────────

function normalizeAndDeduplicate({ 
  candidates, 
  searchPackage, 
  userId = 'anonymous', 
  onProgress = null 
}) {
  console.log(`📋 [Stage4] Starting normalization for user ${userId}...`);
  console.log(`📋 [Stage4] Received ${candidates?.length || 0} candidates from Stage 3`);
  onProgress?.('📋 Normalizing and deduplicating companies...');
  
  // ─── Validate input ───
  if (!candidates || candidates.length === 0) {
    return {
      success: false,
      error: 'No candidates provided to Stage 4',
      companies: [],
      stats: {
        total_input: 0,
        cleaned: 0,
        invalid_removed: 0,
        duplicates_merged: 0,
        final_companies: 0
      }
    };
  }
  
  // ─── Run deduplication ───
  const result = deduplicateCandidates(candidates);
  
  // ─── Add user and search context ───
  result.userId = userId;
  result.search_package = searchPackage;
  result.timestamp = new Date().toISOString();
  
  // ─── Log summary ───
  console.log(`✅ [Stage4] Normalization complete: ${result.companies.length} unique companies`);
  console.log(`📊 [Stage4] Stats:`, result.stats);
  
  return result;
}

// ────────────────────────────────────────────────────────────────
// 11. Helper: Get Company Statistics
// ────────────────────────────────────────────────────────────────

function getCompanyStats(companies) {
  if (!companies || companies.length === 0) {
    return {
      total: 0,
      with_domain: 0,
      with_website: 0,
      with_location: 0,
      with_industry: 0,
      with_description: 0,
      average_confidence: 0,
      merged_count: 0
    };
  }
  
  let withDomain = 0, withWebsite = 0, withLocation = 0, withIndustry = 0, withDescription = 0, merged = 0;
  let totalConfidence = 0;
  
  for (const company of companies) {
    if (company.domain) withDomain++;
    if (company.website) withWebsite++;
    if (company.location) withLocation++;
    if (company.industry) withIndustry++;
    if (company.description) withDescription++;
    if (company.isMerged) merged++;
    totalConfidence += company.confidence || 0;
  }
  
  return {
    total: companies.length,
    with_domain: withDomain,
    with_website: withWebsite,
    with_location: withLocation,
    with_industry: withIndustry,
    with_description: withDescription,
    average_confidence: totalConfidence / companies.length,
    merged_count: merged
  };
}

// ────────────────────────────────────────────────────────────────
// 12. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  normalizeAndDeduplicate,
  deduplicateCandidates,
  cleanCandidate,
  findDuplicates,
  mergeRecords,
  normalizeCompanyName,
  normalizeLocation,
  extractDomain,
  getBaseDomain,
  stringSimilarity,
  levenshteinDistance,
  getCompanyStats,
  FUZZY_MATCH_THRESHOLD,
  MAX_CANDIDATES_AFTER_DEDUPE
};
