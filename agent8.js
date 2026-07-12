'use strict';

/**
 * agent8.js – Stage 8: Skyline Outreach Preparation & Personalization Engine
 * 
 * The outreach preparation engine of Skyline's Lead Intelligence System.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Receive ranked companies from Stage 7.
 * 2. For each company, retrieve the complete business profile.
 * 3. Identify the best public contact method (email).
 * 4. Understand why the company was selected (evidence).
 * 5. Generate personalized outreach messages based on company profile.
 * 6. Perform quality review on generated messages.
 * 7. Build complete outreach packages for each company.
 * 8. Return outreach-ready prospects for Stage 9.
 * 
 * SKYLINE PHILOSOPHY:
 * Stage 8 is about action, not discovery.
 * Everything before Stage 8 was about finding and understanding.
 * Stage 8 prepares everything needed for outreach.
 * 
 * IMPORTANT: This stage does NOT send emails.
 * It prepares outreach packages. The user decides whether and when to send.
 * 
 * YOU MUST NOT:
 * - Send emails (this is a later action).
 * - Make absolute claims ("you definitely need this").
 * - Invent facts not supported by the company profile.
 * - Claim private knowledge.
 * - Skip quality review.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const OUTREACH_MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 600;
const MAX_COMPANIES_TO_PREPARE = 200;
const MAX_CONCURRENT_PREPARATIONS = 5;

// Email priority order
const EMAIL_PRIORITY = [
  'sales@',
  'info@',
  'contact@',
  'hello@',
  'enquiries@',
  'support@',
  'team@',
  'mail@',
  'email@',
  'office@'
];

// ────────────────────────────────────────────────────────────────
// 2. Contact Email Discovery
// ────────────────────────────────────────────────────────────────

function findBestContactEmail(company) {
  // Check if we already have an email
  if (company.email) {
    return {
      email: company.email,
      source: 'existing',
      confidence: 'high'
    };
  }

  // Check email candidates
  if (company.email_candidates && company.email_candidates.length > 0) {
    // Prioritize based on email patterns
    const sortedCandidates = company.email_candidates.sort((a, b) => {
      const aScore = getEmailPriorityScore(a);
      const bScore = getEmailPriorityScore(b);
      return bScore - aScore;
    });

    return {
      email: sortedCandidates[0],
      source: 'candidate',
      confidence: 'medium',
      alternatives: sortedCandidates.slice(1, 3)
    };
  }

  // Try to construct email from domain
  if (company.domain) {
    // Try to construct using common patterns
    const domain = company.domain.replace(/^www\./, '');
    const possibleEmails = [];

    // Generic business emails
    for (const prefix of EMAIL_PRIORITY) {
      possibleEmails.push(`${prefix}${domain}`);
    }

    // Try name-based construction if we have a name
    if (company.name) {
      const nameParts = company.name.split(' ');
      const firstName = nameParts[0]?.toLowerCase() || '';
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join('').toLowerCase() : '';

      if (firstName) {
        possibleEmails.push(`${firstName}@${domain}`);
        if (lastName) {
          possibleEmails.push(`${firstName}.${lastName}@${domain}`);
          possibleEmails.push(`${firstName}${lastName}@${domain}`);
          possibleEmails.push(`${firstName}_${lastName}@${domain}`);
        }
      }
    }

    // Return the first possible email
    if (possibleEmails.length > 0) {
      return {
        email: possibleEmails[0],
        source: 'inferred',
        confidence: 'low',
        alternatives: possibleEmails.slice(1, 4)
      };
    }
  }

  // No email found
  return {
    email: null,
    source: 'none',
    confidence: 'none'
  };
}

function getEmailPriorityScore(email) {
  if (!email) return 0;
  const lower = email.toLowerCase();

  // Highest priority: actual person emails with first name
  if (!EMAIL_PRIORITY.some(p => lower.includes(p))) {
    return 100;
  }

  // Priority based on common business patterns
  for (let i = 0; i < EMAIL_PRIORITY.length; i++) {
    if (lower.startsWith(EMAIL_PRIORITY[i])) {
      return EMAIL_PRIORITY.length - i;
    }
  }

  return 0;
}

// ────────────────────────────────────────────────────────────────
// 3. Generate Outreach Message
// ────────────────────────────────────────────────────────────────

async function generateOutreach(company, searchPackage, userProfile, apiKey) {
  const service = searchPackage?.service_needed || 'our services';
  const senderName = userProfile?.senderName || 'Alex';
  const companyName = company.name || company.company || 'your company';
  const industry = company.industry || 'your industry';
  const employees = company.employees || null;
  const description = company.description || null;
  const hiring = company.hiring || null;
  const techStack = company.tech_stack || [];

  // Build evidence list for personalization
  const evidence = [];

  if (industry) {
    evidence.push(`operates in the ${industry} industry`);
  }
  if (employees) {
    evidence.push(`employs approximately ${employees} people`);
  }
  if (company.location) {
    evidence.push(`is based in ${company.location}`);
  }
  if (hiring) {
    const count = typeof hiring === 'number' ? hiring : 1;
    evidence.push(`has ${count} open positions`);
  }
  if (techStack.length > 0) {
    evidence.push(`uses ${techStack.slice(0, 3).join(', ')}`);
  }
  if (description) {
    // Extract a key insight from description
    const sentences = description.split(/[.!?]+/);
    const relevantSentence = sentences.find(s => 
      s.length > 20 && (s.toLowerCase().includes('health') ||
      s.toLowerCase().includes('tech') || 
      s.toLowerCase().includes('soft') ||
      s.toLowerCase().includes('service'))
    );
    if (relevantSentence) {
      evidence.push(relevantSentence.trim());
    }
  }

  const evidenceText = evidence.length > 0 
    ? evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')
    : 'Limited public information available.';

  const outreachPrompt = `
You are an outreach personalization expert. Generate a personalized cold email for a B2B prospect.

SENDER PROFILE:
- Name: ${senderName}
- Service: ${service}

PROSPECT PROFILE:
- Company: ${companyName}
- Industry: ${company.industry || 'Unknown'}
- Employees: ${company.employees || 'Unknown'}
- Location: ${company.location || 'Unknown'}
- Technology Stack: ${techStack.join(', ') || 'Unknown'}

EVIDENCE (why this company is a prospect):
${evidenceText}

REQUIREMENTS:
1. Write a SHORT, professional cold email (3-4 sentences max for body).
2. Personalize using the evidence provided above.
3. Include ONE clear call to action.
4. DO NOT invent facts not supported by the evidence.
5. DO NOT make absolute claims ("you definitely need this").
6. Keep tone professional and respectful.
7. Include subject line.

OUTPUT FORMAT (JSON):
{
  "subject": "Subject line here",
  "body": "Full email body here"
}`;

  try {
    const response = await withRetry(() => axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OUTREACH_MODEL,
        messages: [
          { 
            role: 'system', 
            content: 'You generate short, personalized cold emails. Return only valid JSON. Never invent facts. Never make absolute claims.' 
          },
          { role: 'user', content: outreachPrompt }
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.7,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    ), 'Stage8:Outreach');

    if (!response) {
      return createFallbackOutreach(company, senderName, service);
    }

    const rawContent = response.data.choices[0].message.content.trim();
    const parsed = JSON.parse(rawContent);

    // Validate the output
    if (!parsed.subject || !parsed.body) {
      return createFallbackOutreach(company, senderName, service);
    }

    return {
      subject: parsed.subject,
      body: parsed.body,
      personalization_used: evidence.slice(0, 3)
    };

  } catch (error) {
    console.error(`❌ [Stage8] Outreach generation failed for ${companyName}:`, error.message);
    return createFallbackOutreach(company, senderName, service);
  }
}

// ────────────────────────────────────────────────────────────────
// 4. Fallback Outreach
// ────────────────────────────────────────────────────────────────

function createFallbackOutreach(company, senderName, service) {
  const companyName = company.name || company.company || 'your company';
  const industry = company.industry || '';

  let personalizedLine = `I'm reaching out because ${companyName}`;
  if (industry) {
    personalizedLine += ` in the ${industry} industry`;
  }
  personalizedLine += ` appears to be growing and may benefit from ${service}.`;

  return {
    subject: `Quick thought on ${companyName}`,
    body: `Hi there,\n\n${personalizedLine}\n\nWould you be open to a brief conversation to explore if there's a fit?\n\nBest,\n${senderName}`,
    personalization_used: ['Company name', industry ? 'Industry' : null].filter(Boolean)
  };
}

// ────────────────────────────────────────────────────────────────
// 5. Quality Review
// ────────────────────────────────────────────────────────────────

function qualityReview(outreach, company) {
  const issues = [];
  const warnings = [];

  // Check for unsupported claims
  const unsupportedPatterns = [
    /definitely need/i,
    /urgently need/i,
    /must have/i,
    /critical you/i,
    /without this/i,
    /you will fail/i,
    /guarantee/i
  ];

  for (const pattern of unsupportedPatterns) {
    if (pattern.test(outreach.body) || pattern.test(outreach.subject)) {
      issues.push('Contains unsupported absolute claim');
      break;
    }
  }

  // Check company name is used correctly
  const companyName = company.name || company.company || '';
  if (companyName && !outreach.body.includes(companyName) && !outreach.subject.includes(companyName)) {
    warnings.push('Company name not mentioned in outreach');
  }

  // Check for over-personalization (inventing facts)
  const inventedPatterns = [
    /i see you/i,
    /i noticed you/i,
    /your recent/i,
    /your team/i
  ];

  for (const pattern of inventedPatterns) {
    if (pattern.test(outreach.body)) {
      warnings.push('May be claiming knowledge of specific internal details');
      break;
    }
  }

  // Check length
  const wordCount = outreach.body.split(' ').length;
  if (wordCount > 150) {
    warnings.push(`Email body is long (${wordCount} words)`);
  }
  if (wordCount < 10) {
    issues.push('Email body is too short');
  }

  // Check for clear CTA
  const ctaPatterns = [
    /call/i,
    /meeting/i,
    /conversation/i,
    /chat/i,
    /discuss/i,
    /explore/i,
    /talk/i,
    /schedule/i,
    /book/i
  ];

  const hasCTA = ctaPatterns.some(p => p.test(outreach.body));
  if (!hasCTA) {
    warnings.push('No clear call to action detected');
  }

  // Determine if review passed
  const passed = issues.length === 0;
  const qualityScore = Math.max(0, 1 - (issues.length * 0.2) - (warnings.length * 0.1));

  return {
    passed: passed,
    score: Math.min(qualityScore, 1.0),
    issues: issues,
    warnings: warnings,
    recommendation: passed ? 'Ready for review' : 'Requires revision'
  };
}

// ────────────────────────────────────────────────────────────────
// 6. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
        console.warn(`⛔ [Stage8] Non-retryable (${err.response.status}): ${err.message}`);
        return null;
      }
      console.warn(`⚠️ [Stage8] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
      if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 7. Prepare a Single Company
// ────────────────────────────────────────────────────────────────

async function prepareSingleCompany(company, searchPackage, userProfile, apiKey, onProgress) {
  const name = company.name || company.company || 'Unknown';
  console.log(`📝 [Stage8] Preparing outreach for: ${name}`);
  onProgress?.(`📝 Preparing ${name}...`);

  // Step 1: Find contact email
  const contact = findBestContactEmail(company);

  // Step 2: Generate personalized outreach
  const outreach = await generateOutreach(company, searchPackage, userProfile, apiKey);

  // Step 3: Quality review
  const review = qualityReview(outreach, company);

  // Step 4: Build evidence summary
  const evidenceSummary = [];

  if (company.industry) evidenceSummary.push(`Industry: ${company.industry}`);
  if (company.employees) evidenceSummary.push(`Employees: ${company.employees}`);
  if (company.location) evidenceSummary.push(`Location: ${company.location}`);
  if (company.hiring) {
    const count = typeof company.hiring === 'number' ? company.hiring : 1;
    evidenceSummary.push(`Hiring: ${count} open positions`);
  }
  if (company.tech_stack && company.tech_stack.length > 0) {
    evidenceSummary.push(`Technology: ${company.tech_stack.slice(0, 3).join(', ')}`);
  }

  const rankInfo = company.rank ? `Rank #${company.rank}` : 'Not ranked';

  return {
    // Company identity
    company_name: company.name || company.company || 'Unknown',
    company_domain: company.domain || null,
    company_industry: company.industry || null,
    company_location: company.location || null,
    company_employees: company.employees || null,

    // Contact
    contact_email: contact.email,
    contact_source: contact.source,
    contact_confidence: contact.confidence,
    contact_alternatives: contact.alternatives || [],

    // Outreach
    outreach_subject: outreach.subject,
    outreach_body: outreach.body,
    personalization_used: outreach.personalization_used || [],

    // Evidence
    evidence_summary: evidenceSummary,
    reason_selected: company.rank_explanations || ['Selected based on relevance and confidence'],

    // Quality
    quality_score: review.score,
    quality_passed: review.passed,
    quality_issues: review.issues,
    quality_warnings: review.warnings,
    quality_recommendation: review.recommendation,

    // Metadata
    rank: company.rank || null,
    rank_label: company.rank_label || null,
    confidence: company.ranking?.score || company.confidence || 0.30,
    search_context: searchPackage?.service_needed || 'General lead generation',
    prepared_at: new Date().toISOString(),

    // Preserve original data
    _original: company
  };
}

// ────────────────────────────────────────────────────────────────
// 8. Main Stage 8 Function: Outreach Preparation
// ────────────────────────────────────────────────────────────────

async function prepareOutreach({
  companies,
  searchPackage,
  userProfile = { senderName: 'Alex' },
  apiKey,
  userId = 'anonymous',
  onProgress = null,
  limit = MAX_COMPANIES_TO_PREPARE
}) {
  console.log(`📝 [Stage8] Starting outreach preparation for user ${userId}...`);
  console.log(`📊 [Stage8] Received ${companies?.length || 0} companies from Stage 7`);
  onProgress?.('📝 Preparing outreach...');

  // ─── Validate input ───
  if (!companies || companies.length === 0) {
    return {
      success: false,
      error: 'No companies provided to Stage 8',
      prepared_prospects: [],
      stats: {
        total_input: 0,
        prepared: 0,
        with_email: 0,
        quality_passed: 0
      }
    };
  }

  if (!apiKey) {
    console.warn('⚠️ [Stage8] No API key provided, using fallback outreach');
  }

  // ─── Limit companies to prepare ───
  const companiesToPrepare = companies.slice(0, limit);
  const skipped = companies.length - companiesToPrepare.length;

  console.log(`📊 [Stage8] Preparing ${companiesToPrepare.length} companies (${skipped} skipped due to limit)`);

  // ─── Prepare each company ───
  const preparedProspects = [];
  let withEmail = 0;
  let qualityPassed = 0;

  // Process in batches with concurrency control
  const batches = [];
  for (let i = 0; i < companiesToPrepare.length; i += MAX_CONCURRENT_PREPARATIONS) {
    batches.push(companiesToPrepare.slice(i, i + MAX_CONCURRENT_PREPARATIONS));
  }

  for (const batch of batches) {
    const batchPromises = batch.map(company =>
      prepareSingleCompany(company, searchPackage, userProfile, apiKey, onProgress)
    );
    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value) {
        const prepared = result.value;
        preparedProspects.push(prepared);

        if (prepared.contact_email) withEmail++;
        if (prepared.quality_passed) qualityPassed++;
      } else {
        // Failed preparation - keep minimal data
        const company = batch[0] || { name: 'Unknown' };
        preparedProspects.push({
          company_name: company.name || company.company || 'Unknown',
          company_domain: company.domain || null,
          contact_email: null,
          outreach_subject: 'Unable to generate outreach',
          outreach_body: 'Outreach generation failed. Please try again.',
          quality_passed: false,
          quality_issues: ['Outreach generation failed'],
          _error: result.reason?.message || 'Preparation failed'
        });
      }
    }
  }

  // ─── Calculate stats ───
  const stats = {
    total_input: companies.length,
    prepared: preparedProspects.length,
    skipped: skipped,
    with_email: withEmail,
    quality_passed: qualityPassed,
    quality_rate: preparedProspects.length > 0 ? qualityPassed / preparedProspects.length : 0
  };

  console.log(`✅ [Stage8] Outreach preparation complete: ${preparedProspects.length} companies prepared`);
  console.log(`📊 [Stage8] ${withEmail} have contact emails, ${qualityPassed} passed quality review`);

  return {
    success: true,
    prospects: preparedProspects,
    stats: stats,
    userId: userId,
    search_package: searchPackage,
    timestamp: new Date().toISOString()
  };
}

// ────────────────────────────────────────────────────────────────
// 9. Helper: Get Outreach Statistics
// ────────────────────────────────────────────────────────────────

function getOutreachStats(prospects) {
  if (!prospects || prospects.length === 0) {
    return {
      total: 0,
      with_email: 0,
      email_sources: {},
      quality_distribution: {},
      average_quality_score: 0
    };
  }

  const emailSources = {};
  const qualityDistribution = {
    passed: 0,
    failed: 0
  };

  let totalQuality = 0;

  for (const p of prospects) {
    // Email sources
    const source = p.contact_source || 'none';
    emailSources[source] = (emailSources[source] || 0) + 1;

    // Quality
    if (p.quality_passed) {
      qualityDistribution.passed++;
    } else {
      qualityDistribution.failed++;
    }

    totalQuality += p.quality_score || 0;
  }

  return {
    total: prospects.length,
    with_email: prospects.filter(p => p.contact_email).length,
    email_sources: emailSources,
    quality_distribution: qualityDistribution,
    average_quality_score: totalQuality / prospects.length
  };
}

// ────────────────────────────────────────────────────────────────
// 10. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  prepareOutreach,
  prepareSingleCompany,
  findBestContactEmail,
  generateOutreach,
  qualityReview,
  getOutreachStats,
  EMAIL_PRIORITY,
  MAX_COMPANIES_TO_PREPARE,
  MAX_CONCURRENT_PREPARATIONS
};
