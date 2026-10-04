'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';
const MAX_ATTEMPTS = 2;

// ────────────────────────────────────────────────────────────────
// SEARCH CAPACITY BUCKETS
// ────────────────────────────────────────────────────────────────

// Fixed search-capacity buckets used by the fallback allocation.
// Each 10-lead range from 1 to 1,000 maps to a search capacity equal
// to the upper bound of that range.
// These are search-capacity limits, not searches per lead.

const SEARCH_CAPACITY_BUCKET_SIZE = 10;
const SEARCH_CAPACITY_MAX_BUCKET = 1000;

// Fixed percentage distribution used by the fallback allocation.
// Category order matters — it determines the output key order.

const FALLBACK_ALLOCATION_DISTRIBUTION = {
    companyDiscovery: 0.42,
    qualificationInvestigation: 0.17,
    signalEvidenceInvestigation: 0.25,
    otherSupportingSearches: 0.16,
};

// ────────────────────────────────────────────────────────────────
// FALLBACK STRATEGY BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the fallback strategy from the Understanding output using the
// conditional fallback rules:
//   IF target exists        → start with target + location
//   IF qualification exists → plan to check those qualifications
//   IF signals exist        → plan to investigate those signals
//   IF exclusions exist     → plan to exclude them
//   IF quantity exists      → search toward that quantity
//   IF need exists          → include the need when designing the search approach

function buildFallbackStrategy(understanding) {
    const parts = [];

    if (understanding.targetEntity) {
        const city = understanding.location?.city ?? '';
        const country = understanding.location?.country ?? '';
        parts.push(
            `start with ${understanding.targetEntity} in ${city}, ${country}`
        );
    }

    if (understanding.qualification) {
        parts.push(`plan to check ${understanding.qualification}`);
    }

    if (understanding.signal) {
        parts.push(`plan to investigate ${understanding.signal}`);
    }

    if (understanding.exclusions) {
        parts.push(`plan to exclude ${understanding.exclusions}`);
    }

    if (understanding.quantity) {
        parts.push(`search toward ${understanding.quantity}`);
    }

    if (understanding.problem) {
        parts.push(
            `include ${understanding.problem} need when designing the search approach`
        );
    }

    return parts.join(' → ');
}

// ────────────────────────────────────────────────────────────────
// FALLBACK SOURCE BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the fallback source selection from the Understanding output using
// fixed field-presence rules. The code does not read the original request,
// does not match keywords, and does not decide the meaning of any field.
// It only checks which Understanding fields are present and emits the
// predefined source phrase associated with each field.

function buildFallbackSource(understanding) {
    const parts = [];

    const information = Array.isArray(understanding.information)
        ? understanding.information
        : [];

    if (understanding.targetEntity) {
        parts.push('search engines and relevant directories');
    }

    if (information.includes('companyName')) {
        parts.push('official company websites');
    }

    if (
        information.includes('companyEmail') ||
        information.includes('phoneNumber')
    ) {
        parts.push('contact pages and public business sources');
    }

    if (understanding.qualification) {
        parts.push('reliable business sources');
    }

    if (understanding.signal) {
        parts.push('relevant authoritative sources');
    }

    if (parts.length === 0) {
        parts.push(
            'search engine, official website, and relevant authoritative sources'
        );
    }

    return parts.join(' → ');
}

// ────────────────────────────────────────────────────────────────
// FALLBACK QUERY BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the fallback query list from the Understanding output using fixed
// field-combination rules. The code does not read the original request,
// does not match keywords, and does not decide the meaning of any field.
// It only combines the structured fields already produced by Understanding.
//
// The combinations are applied in this order:
//   Target + Location
//   Target + Problem
//   Target + Location + Problem
//   Target + Location + Signal
//   Target + Signal

function buildFallbackQuery(understanding) {
    const queries = [];

    const target = understanding.targetEntity;
    const city = understanding.location?.city ?? '';
    const country = understanding.location?.country ?? '';
    const location = `${city} ${country}`.trim();
    const problem = understanding.problem;
    const signal = understanding.signal;

    if (target && location) {
        queries.push(`${target} ${location}`);
    }

    if (target && problem) {
        queries.push(`${target} ${problem}`);
    }

    if (target && location && problem) {
        queries.push(`${target} ${location} ${problem}`);
    }

    if (target && location && signal) {
        queries.push(`${target} ${location} ${signal}`);
    }

    if (target && signal) {
        queries.push(`${target} ${signal}`);
    }

    return queries;
}

// ────────────────────────────────────────────────────────────────
// FALLBACK EVIDENCE SEARCH BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the fallback evidence search list from the Understanding output
// using three fixed field-combination patterns. The code does not read the
// original request, does not match keywords, and does not decide the meaning
// of any field. It only combines the structured fields already produced by
// Understanding.
//
// Because targetEntity, location, and signal are guaranteed to exist (the
// Understanding layer provides its own fallbacks for all three), these are
// three fixed patterns rather than conditional branches.
//
// The patterns are applied in this order:
//   Target + Location + Signal
//   Target + Signal
//   Location + Signal

function buildFallbackEvidenceSearch(understanding) {
    const evidenceSearch = [];

    const target = understanding.targetEntity;
    const city = understanding.location?.city ?? '';
    const country = understanding.location?.country ?? '';
    const location = `${city} ${country}`.trim();
    const signal = understanding.signal;

    if (target && location && signal) {
        evidenceSearch.push(`${target} ${location} ${signal}`);
    }

    if (target && signal) {
        evidenceSearch.push(`${target} ${signal}`);
    }

    if (location && signal) {
        evidenceSearch.push(`${location} ${signal}`);
    }

    return evidenceSearch;
}

// ────────────────────────────────────────────────────────────────
// FALLBACK ALLOCATION BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the fallback allocation from the Understanding output using the
// fixed search-capacity table and a fixed percentage distribution.
//
// Step 1: extract the requested leads from the already-structured quantity
//         string. This is parsing an already-structured field, not
//         re-understanding the user's request.
// Step 2: select the matching bucket → fixed total search capacity.
//         Each 10-lead range from 1 to 1,000 maps to a search capacity
//         equal to the upper bound of that range.
//         If no number is present (for example "as many as possible"),
//         use the maximum bucket (1,000 searches).
// Step 3: apply the fixed percentage distribution.
// Step 4: round to integers and correct any rounding drift on the largest
//         category, so the distribution always sums to the total.

function buildFallbackAllocation(understanding) {
    // Step 1: extract requested leads from the quantity string
    const quantityString =
        typeof understanding.quantity === 'string'
            ? understanding.quantity
            : '';
    const match = quantityString.match(/\d+/);
    const requestedLeads = match ? parseInt(match[0], 10) : null;

    // Step 2: select bucket → total search capacity
    // Each 10-lead range from 1 to 1,000 maps to a search capacity equal to
    // the upper bound of that range. Anything above 1,000 or without a
    // number uses the maximum bucket.
    let totalSearches = SEARCH_CAPACITY_MAX_BUCKET;

    if (requestedLeads !== null) {
        const roundedUp =
            Math.ceil(requestedLeads / SEARCH_CAPACITY_BUCKET_SIZE) *
            SEARCH_CAPACITY_BUCKET_SIZE;

        totalSearches = Math.min(
            roundedUp,
            SEARCH_CAPACITY_MAX_BUCKET
        );
    }

    // Step 3: apply the fixed percentage distribution
    const categories = Object.keys(FALLBACK_ALLOCATION_DISTRIBUTION);
    const distribution = {};
    let sum = 0;

    for (const category of categories) {
        const value = Math.round(
            totalSearches * FALLBACK_ALLOCATION_DISTRIBUTION[category]
        );
        distribution[category] = value;
        sum += value;
    }

    // Step 4: correct rounding drift on the largest category
    if (sum !== totalSearches) {
        const delta = totalSearches - sum;

        let largestCategory = categories[0];
        for (const category of categories) {
            if (distribution[category] > distribution[largestCategory]) {
                largestCategory = category;
            }
        }

        distribution[largestCategory] += delta;
    }

    return {
        totalSearches,
        distribution,
    };
}

// ────────────────────────────────────────────────────────────────
// ALLOCATION VALIDATION
// ────────────────────────────────────────────────────────────────

// Returns true when the AI-provided allocation is structurally valid:
// an object with a positive integer totalSearches and a non-empty
// distribution of non-negative integer values that sums to totalSearches.

function isValidAllocation(allocation) {
    if (!allocation || typeof allocation !== 'object') {
        return false;
    }

    if (
        !Number.isInteger(allocation.totalSearches) ||
        allocation.totalSearches <= 0
    ) {
        return false;
    }

    const distribution = allocation.distribution;

    if (
        !distribution ||
        typeof distribution !== 'object' ||
        Array.isArray(distribution)
    ) {
        return false;
    }

    const keys = Object.keys(distribution);

    if (keys.length === 0) {
        return false;
    }

    let sum = 0;

    for (const key of keys) {
        const value = distribution[key];

        if (!Number.isInteger(value) || value < 0) {
            return false;
        }

        sum += value;
    }

    if (sum !== allocation.totalSearches) {
        return false;
    }

    return true;
}

// ────────────────────────────────────────────────────────────────
// FALLBACK SEARCH EXPANSION BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the fallback search expansion from the Understanding output and the
// already-generated queries. The code does not read the original request,
// does not match keywords, and does not decide the meaning of any field.
// It only combines the structured fields already produced by Understanding.
//
// The five fixed combination rules are applied in this order:
//   Target + Location + Signal
//   Target + Location + Qualification
//   Target + Location + Problem
//   Location + Target + Signal
//   Location + Target + Qualification
//
// Any query already present in the existing plan queries is removed.
// Any duplicate within the expansion list is removed.
// The surviving queries are joined into a single descriptive string,
// followed by the stop rule.

function buildFallbackSearchExpansion(understanding, plan) {
    const expansions = [];

    const target = understanding.targetEntity;
    const city = understanding.location?.city ?? '';
    const country = understanding.location?.country ?? '';
    const location = `${city} ${country}`.trim();
    const signal = understanding.signal;
    const qualification = understanding.qualification;
    const problem = understanding.problem;

    if (target && location && signal) {
        expansions.push(`${target} ${location} ${signal}`);
    }

    if (target && location && qualification) {
        expansions.push(`${target} ${location} ${qualification}`);
    }

    if (target && location && problem) {
        expansions.push(`${target} ${location} ${problem}`);
    }

    if (location && target && signal) {
        expansions.push(`${location} ${target} ${signal}`);
    }

    if (location && target && qualification) {
        expansions.push(`${location} ${target} ${qualification}`);
    }

    // Dedupe against existing plan queries and within the expansion list.
    const existingQueries = Array.isArray(plan?.query) ? plan.query : [];

    const seen = new Set(
        existingQueries
            .filter((q) => typeof q === 'string')
            .map((q) => q.trim().toLowerCase())
    );

    const unique = [];

    for (const expansion of expansions) {
        const key = expansion.trim().toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(expansion.trim());
        }
    }

    const expansionPart = unique.join(' → ');

    const stopRule =
        'continue searching only while new useful leads are being found, searches remain, and new approaches exist; otherwise stop and return the leads already found without inventing new ones';

    if (expansionPart.length === 0) {
        return stopRule;
    }

    return `${expansionPart} → ${stopRule}`;
}

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the output of the Understanding layer. The Understanding layer
has already determined what the user wants: the target entity, problem, intent,
location, industry, qualification, signal, quantity, information, exclusions,
and constraints.

Your only task is to create the Search Strategy, the Source Selection, the
Query Generation, the Signal Search Planning, the Search Allocation, and the
Search Expansion and Refinement plan.

Search Strategy is the overall plan for how to find the leads the user
requested.

Search Strategy answers the question: what overall approach should be used to
find these leads?

The Understanding layer has already determined what the user wants. Search
Strategy now turns that understanding into a high-level search approach.

The strategy determines the general path of the search, such as:

1. What should be searched for first.
2. What should be investigated afterward.
3. Which requirements should guide the search.
4. How the different parts of the request work together.
5. What should happen if the first approach does not produce enough candidates.

The exact websites, search queries, and search budget are handled by other
components. Do not include them in the strategy.

Search Strategy does not actually search. It does not report results. It does
not say that a specific entity was found. Instead, it describes how the search
should be carried out.

The strategy must describe what needs to be investigated. It must not claim
that the investigation has already succeeded.

Use forward-looking and investigative language, such as:
search for, look for, investigate, check for, plan to, continue looking for.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Example:

If the Understanding output is:

{
  "targetEntity": "hospitals",
  "problem": "MRI equipment",
  "intent": "to find hospitals in Chicago that require MRI equipment and are hiring radiology staff",
  "location": { "city": "Chicago", "country": "USA" },
  "industry": "healthcare",
  "qualification": "revenue over $10M",
  "signal": "hiring radiology staff",
  "quantity": "200 hospitals",
  "information": [
    "companyName",
    "companyEmail",
    "phoneNumber",
    "shortCompanyInformation"
  ],
  "exclusions": "government-owned facilities",
  "constraints": "results must not include duplicates"
}

A suitable Search Strategy would be:

"Search for hospitals in Chicago → plan to exclude government-owned facilities
→ plan to check which hospitals meet the revenue requirement → plan to
investigate evidence related to MRI needs, including radiology hiring →
continue searching for suitable candidates until enough valid leads are
available."

Decide the Search Strategy yourself from the complete meaning of the
Understanding output.
Do not use keyword matching.
Do not follow a predefined strategy list.
Do not allow the code or any external rule to decide the strategy.
Return the most accurate plain-text description of the search strategy.

The strategy must be a clear, meaningful plain-text description of the overall
approach. Do not return an empty or null strategy.

Source Selection instructions:

Source Selection is deciding where to look for the information that is needed.

Source Selection answers the question: what types of sources should be used?

Source Selection does not search yet. It only tells the Discovery layer which
sources to investigate.

Source Selection must describe what sources should be investigated. It must
not claim that any source has already been searched, and it must not claim
that any result has already been found.

Use forward-looking and investigative language, such as:
look in, investigate, use, check, search.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

The source selection must be a clear, meaningful plain-text description of the
types of sources to investigate. Do not return an empty or null source
selection.

Decide the Source Selection yourself from the complete meaning of the
Understanding output.
Do not use keyword matching.
Do not follow a predefined source list.
Do not allow the code or any external rule to decide the source selection.

Examples of suitable Source Selections (these are only examples, not limits):

"search engines and healthcare directories → official clinic websites →
careers pages and job postings → reliable business sources → official
contact pages"

"search engines and business directories → official company websites →
company announcements and relevant news → official contact pages"

Query Generation instructions:

Query Generation is creating the actual search phrases that will be sent to
the search system.

Query Generation answers the question: what exact searches should be sent?

The user gives a request. That request is not always a good search query.
Natural language is often too broad or too complicated for effective
searching. The user might ask for companies that need cybersecurity, but a
search engine may not have a page literally saying that a company needs
cybersecurity.

Query Generation turns the Understanding output and the Planning decisions
into multiple targeted search queries that the Discovery layer can execute.

Query Generation creates queries around observable evidence. Examples of
observable evidence include: hiring activity, job postings, compliance
requirements, incidents, technology expansion, announcements, and any other
evidence that supports the possibility that the need exists. These are only
examples, not limits.

Query Generation does not decide whether a company is actually a good lead.
It only creates the searches. The decision about whether a company is a good
lead belongs to later stages.

Query Generation must describe what searches to send. It must not claim that
any search has already been performed, and it must not claim that any result
has already been found.

Use forward-looking language, such as:
search for, look for, investigate, check for.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Example:

If the Understanding output is for fintech companies in London that need
cybersecurity solutions, are hiring security engineers, and have 100 or more
employees, a suitable Query Generation would be:

[
  "fintech companies London UK",
  "London fintech companies hiring security engineers",
  "London fintech companies cybersecurity jobs",
  "London fintech companies 100+ employees",
  "London fintech companies security compliance"
]

Decide the Query Generation yourself from the complete meaning of the
Understanding output.
Do not use keyword matching.
Do not follow a predefined query list.
Do not allow the code or any external rule to decide the queries.
Return the most accurate list of search queries.

The queries must be a non-empty list of non-empty search phrases.

Signal Search Planning instructions:

Signal Search Planning is deciding how to search for evidence that a company
may match the user's need.

Signal Search Planning answers the question: how should the signal be
investigated?

The signal cannot be searched directly. A search engine does not have pages
that say a company needs a specific thing. Instead, the search must look for
evidence that supports the possibility that the need exists.

Signal Search Planning does not perform the search. It does not report
results. It does not say that any piece of evidence was found. It only
describes how to investigate the signal.

The evidence that is searched for is different from the signal itself.
For example:

If the signal is hiring security engineers, suitable evidence searches could
include: company security engineer jobs, company cybersecurity hiring.

If the signal is a security incident, suitable evidence searches could
include: company security incident, company data breach.

These are only examples, not limits.

The Signal Search Planning must describe how to investigate the signal. It
must not claim that any investigation has already been performed, and it must
not claim that any evidence has already been found.

Use forward-looking and investigative language, such as:
search for, look for, investigate, check for.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Decide the Signal Search Planning yourself from the complete meaning of the
Understanding output.
Do not use keyword matching.
Do not follow a predefined signal search list.
Do not allow the code or any external rule to decide the signal search.

The evidence searches must be a non-empty list of non-empty search phrases.

Search Allocation instructions:

Search Allocation is deciding how to distribute the available searches among
the different search tasks.

Search Allocation answers the question: how much should be searched for each
task?

The searches are paid search resources. They must not be spent endlessly on
one task. The goal is to use the available search capacity efficiently.

Query Generation decides what to search. Signal Search Planning decides how to
investigate the signal. Search Allocation decides how much to search each task.

The totalSearches value is a search-capacity limit, not a number of searches
per lead. One search can return many candidate companies. The results are then
extracted, deduplicated, and verified by later stages.

The Search Allocation must contain:

1. totalSearches — a positive integer that represents the total search
   capacity for this request.
2. distribution — an object that maps a task name to a positive integer
   number of searches.

The distribution must sum exactly to totalSearches.

The totalSearches value is based on the number of leads the user requested.
The total search capacity is equal to the upper bound of the ten-lead range
that the requested quantity falls into. For example:

- 1 to 10 leads → 10 searches
- 11 to 20 leads → 20 searches
- 21 to 30 leads → 30 searches
- 41 to 50 leads → 50 searches
- 91 to 100 leads → 100 searches
- 191 to 200 leads → 200 searches
- 291 to 300 leads → 300 searches
- 991 to 1,000 leads → 1,000 searches

Any request above 1,000 leads uses 1,000 searches. Any request without a
clear number uses 1,000 searches.

You may choose task names that fit the request. Examples of suitable task
names include: companyDiscovery, qualificationInvestigation,
signalEvidenceInvestigation, otherSupportingSearches. These are only
examples, not limits. You may also create request-specific task names when
they fit the request better.

The Search Allocation must be a clear, meaningful plan for how to distribute
the searches. Do not return an empty or null allocation.

Example:

If the request is for 200 leads, a suitable Search Allocation would be:

{
  "totalSearches": 200,
  "distribution": {
    "companyDiscovery": 84,
    "qualificationInvestigation": 34,
    "signalEvidenceInvestigation": 50,
    "otherSupportingSearches": 32
  }
}

Search Expansion and Refinement instructions:

Search Expansion and Refinement is the plan for what to do when the first
round of searching is not enough.

Search Expansion and Refinement answers the question: those searches were not
enough, what should be changed or tried next?

The four expansion types are:

1. Expand the search wording. The original wording may not find everything.
   Related wording can be tried instead.
2. Expand the location. If only a country was searched, important locations
   within that country can be tried.
3. Expand the sources. Additional source types can be investigated.
4. Refine unsuccessful searches. A search that produced many irrelevant
   results can be made more specific.

Search Expansion and Refinement does not perform the search. It does not
report results. It only describes what to try next.

Search Expansion and Refinement must never change, remove, or weaken the
qualification, exclusion, or constraint.

Search Expansion and Refinement must continue only while new useful leads are
being found, searches remain, and reasonable new approaches exist.

If the planned expansions have been tried and the requested quantity is still
not reached, the search must stop and return the leads already found. It must
not invent the missing leads.

Example:

If the Understanding output is for 300 healthcare companies in Germany, and
the first searches only found 85 useful companies, a suitable Search Expansion
and Refinement plan would describe how to broaden the search wording, expand
the location to important cities, add additional source types, and continue
only while new useful leads are being found.

Use forward-looking language, such as:
search for, look for, investigate, check for, plan to.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Decide the Search Expansion and Refinement yourself from the complete meaning
of the Understanding output.
Do not use keyword matching.
Do not follow a predefined expansion list.
Do not allow the code or any external rule to decide the expansion plan.

The Search Expansion and Refinement must be a clear, meaningful plain-text
description of what to change or try next. Do not return an empty or null
expansion plan.

Do not explain your answer.
Do not perform a search.
Do not provide recommendations.
Do not add evidence.
Do not add confidence scores.
Do not invent unnecessary details.

Return only valid JSON using exactly this format:

{
  "strategy": "the search strategy",
  "source": "the selected sources",
  "query": ["the first search query", "the second search query"],
  "evidenceSearch": ["the first evidence search", "the second evidence search"],
  "allocation": {
    "totalSearches": 200,
    "distribution": {
      "companyDiscovery": 84,
      "qualificationInvestigation": 34,
      "signalEvidenceInvestigation": 50,
      "otherSupportingSearches": 32
    }
  },
  "searchExpansion": "the search expansion and refinement plan"
}
`;

// ────────────────────────────────────────────────────────────────
// PLAN REQUEST
// ────────────────────────────────────────────────────────────────

async function planRequest(understanding) {
    console.log('[PlanRequest] Started');
    console.log('[PlanRequest] Received understanding:', understanding);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[PlanRequest] Attempt ${attempt}/${MAX_ATTEMPTS}`
        );

        try {
            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: {
                    type: 'json_object',
                },
                messages: [
                    {
                        role: 'system',
                        content: SYSTEM_INSTRUCTIONS,
                    },
                    {
                        role: 'user',
                        content: `Understanding output:\n${JSON.stringify(
                            understanding,
                            null,
                            2
                        )}`,
                    },
                ],
            });

            console.log('[PlanRequest] OpenAI response received');

            const content = completion.choices?.[0]?.message?.content;

            console.log('[PlanRequest] Raw model response:', content);

            if (!content) {
                console.error(
                    '[PlanRequest] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[PlanRequest] Parsed model response:',
                parsedResult
            );

            const strategy = parsedResult?.strategy;
            const source = parsedResult?.source;
            const query = parsedResult?.query;
            const evidenceSearch = parsedResult?.evidenceSearch;
            const allocation = parsedResult?.allocation;
            const searchExpansion = parsedResult?.searchExpansion;

            if (
                typeof strategy === 'string' &&
                strategy.trim().length > 0
            ) {
                const normalizedQuery =
                    Array.isArray(query) &&
                    query.filter(
                        (q) => typeof q === 'string' && q.trim().length > 0
                    ).length > 0
                        ? query
                              .filter(
                                  (q) =>
                                      typeof q === 'string' &&
                                      q.trim().length > 0
                              )
                              .map((q) => q.trim())
                        : buildFallbackQuery(understanding);

                const normalizedEvidenceSearch =
                    Array.isArray(evidenceSearch) &&
                    evidenceSearch.filter(
                        (e) => typeof e === 'string' && e.trim().length > 0
                    ).length > 0
                        ? evidenceSearch
                              .filter(
                                  (e) =>
                                      typeof e === 'string' &&
                                      e.trim().length > 0
                              )
                              .map((e) => e.trim())
                        : buildFallbackEvidenceSearch(understanding);

                const normalizedAllocation = isValidAllocation(allocation)
                    ? allocation
                    : buildFallbackAllocation(understanding);

                const normalizedSearchExpansion =
                    typeof searchExpansion === 'string' &&
                    searchExpansion.trim().length > 0
                        ? searchExpansion.trim()
                        : buildFallbackSearchExpansion(understanding, {
                              query: normalizedQuery,
                          });

                const result = {
                    strategy: strategy.trim(),

                    source:
                        typeof source === 'string' &&
                        source.trim().length > 0
                            ? source.trim()
                            : buildFallbackSource(understanding),

                    query: normalizedQuery,

                    evidenceSearch: normalizedEvidenceSearch,

                    allocation: normalizedAllocation,

                    searchExpansion: normalizedSearchExpansion,
                };

                console.log('[PlanRequest] Final result:', result);

                return result;
            }

            console.warn(
                '[PlanRequest] No valid strategy returned'
            );
        } catch (error) {
            console.error(
                `[PlanRequest] Attempt ${attempt} failed`
            );

            console.error('[PlanRequest] Error name:', error.name);
            console.error('[PlanRequest] Error message:', error.message);
            console.error('[PlanRequest] Error status:', error.status);
            console.error('[PlanRequest] Full error:', error);
        }
    }

    const fallbackQuery = buildFallbackQuery(understanding);

    const fallbackResult = {
        strategy: buildFallbackStrategy(understanding),
        source: buildFallbackSource(understanding),
        query: fallbackQuery,
        evidenceSearch: buildFallbackEvidenceSearch(understanding),
        allocation: buildFallbackAllocation(understanding),
        searchExpansion: buildFallbackSearchExpansion(understanding, {
            query: fallbackQuery,
        }),
    };

    console.warn(
        '[PlanRequest] All attempts failed. Using fallback:',
        fallbackResult
    );

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = planRequest;
