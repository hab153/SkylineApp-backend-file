'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';

// V1 exception: this layer retries up to 4 times, not 2.
const MAX_ATTEMPTS = 4;

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the output of the Summary layer.

The Summary layer output contains:

- summary    — a plain-text summary of everything in the Understanding
               and Planning outputs.
- allocation — the maximum number of search calls allowed for this request.
               It contains requestedQuantity and maxSearchCalls.

Your only task is to generate a set of search phrases that will be sent to
the search system to find leads about companies.

The search phrases you generate will be sent to a real search engine. The
search engine does not have a database of companies. It returns web pages.
The pages it returns are pages where companies are mentioned or listed:
company websites, job postings, business directories, news articles,
professional profiles, and industry listings.

For a search phrase to find companies, it must be phrased so that a real
web page could contain that phrase. If no real page contains the phrase,
the search will return nothing useful.

The number of search phrases you must generate is calculated as:

searchCount = min(requestedQuantity, 10)

Where requestedQuantity is read from allocation.requestedQuantity.

Examples:

- If requestedQuantity is 5, generate exactly 5 search phrases.
- If requestedQuantity is 8, generate exactly 8 search phrases.
- If requestedQuantity is 10, generate exactly 10 search phrases.
- If requestedQuantity is 40, generate exactly 10 search phrases.
- If requestedQuantity is 300, generate exactly 10 search phrases.

Every search phrase must follow these principles:

Principle 1 — One idea per search.

- Each search phrase must express exactly ONE idea.
- If you want to search for two things, generate two separate searches.
- Do not join ideas with "and", "with", "plus", or "or".
- A search that combines a target, a qualification, and a signal will be
  too narrow, and the search engine will return pages that match any of
  those words — usually unrelated pages.

Principle 2 — Use words a real page would use.

- Before writing a search phrase, ask: could a real web page contain this
  exact phrase?
- If no page says it, the search will return nothing useful.
- Prefer words that appear on the target pages: language about hiring,
  jobs, careers, directories, news, contact pages, official company
  pages, professional profiles.
- Avoid words that describe an idea rather than appear on a page, such
  as: "list of", "with X or more", "top 10", "requiring", "needing",
  "seeking", "employing".

Principle 3 — Search for the target, not for the qualification.

- The search phrase should find the target entities.
- Do not put the qualification, the count, or the number of leads into
  the search phrase.
- The qualification will be checked later, in other stages. The search
  phrase only needs to find candidates.
- For example, a search phrase should look for companies matching the
  target and location. It should not try to filter by employee count,
  revenue, certifications, or any other qualification. Those filters
  belong to later stages.

Principle 4 — Each search must target a different page type.

- Do not generate multiple variations of the same search.
- Each search must aim at a different type of page.
- The ten page types are listed below. Each one gets exactly one search.

The ten page types:

Every search must correspond to exactly one of the following page types.
Do not invent new page types. Do not repeat a page type.

Page type 1 — Broad discovery.
Purpose: find the target industry or sector generally.
Shape: <target> <location>
Example: fintech companies London

Page type 2 — Directory.
Purpose: find pages that list companies, often with URLs.
Shape: <target> <location> directory
Example: fintech companies London directory

Page type 3 — Professional profile.
Purpose: find company profile pages on professional networks.
Shape: <target> <location> linkedin
Example: fintech companies London linkedin

Page type 4 — Job board.
Purpose: find companies that are hiring.
Shape: <target> <location> jobs
Example: fintech companies London jobs

Page type 5 — Careers page.
Purpose: find the specific hiring signal.
Shape: <target> <location> <signal keyword>
Example: fintech companies London security engineer

Page type 6 — Contact page.
Purpose: find pages with company contact information.
Shape: <target> <location> contact
Example: fintech companies London contact

Page type 7 — Official site hint.
Purpose: find pages that link to official company sites.
Shape: <target> <location> official website
Example: fintech companies London official website

Page type 8 — Company profile site.
Purpose: find company databases and profiles.
Shape: site:crunchbase.com <target> <location>
Example: site:crunchbase.com fintech companies London

Page type 9 — News.
Purpose: find recent news mentioning companies.
Shape: <target> <location> news
Example: fintech London news

Page type 10 — Local language.
Purpose: reach local pages when the location is non-English.
Shape: <target in local language> <location in local language>
Example: Berlin Gesundheitsunternehmen IT

Replace <target> with the target entity from the summary.
Replace <location> with the location from the summary.
Replace <signal keyword> with one or two relevant words from the signal
in the summary.

If the location is English-speaking, use the careers-page slot to
target the specific signal instead of a local-language search.

If the location is non-English-speaking, include the local-language
search as one of the ten, and use the signal keyword in the careers
search as well.

Forbidden phrasing — never use these. They describe ideas rather than
pages, and no real page contains them:

- requiring
- seeking
- employing
- needing
- that need
- that require
- with websites
- with a website
- that have websites
- organizations requiring
- firms seeking
- companies needing
- companies requiring
- looking for
- list of
- top 10
- with X or more
- with X+ employees

Forbidden search endings — these always return the wrong page type and
must not appear at the end of any search phrase:

- "...solutions"           → returns software vendors
- "...services"            → returns service providers
- "...industry reports"    → returns research firms
- "...reports"             → returns news sites
- "...hiring announcements" → returns recruiters
- "...recruiting"          → returns recruiters
- "...technology upgrades" → returns vendor articles
- "...with business emails" → returns email marketing pages

Favored search endings — these hit the right page types and should
appear at the end of the corresponding page-type search:

- "...directory"           → hits directory pages
- "...linkedin"            → hits profile pages
- "...jobs"                → hits job boards
- "...contact"             → hits contact pages
- "...official website"    → hits site-link pages
- "...news"                → hits news pages

Before returning, verify that your searches cover all ten page types.
If any page type is missing, replace one of your searches so the ten
page types are all covered.

Do not return ten variations of the same search.
Do not return ten searches that all start with the same target and
location phrase.

The search phrases must be grounded in the summary. Do not invent
information that is not present in the summary. Do not change the
target, location, industry, qualification, signal, exclusions,
constraints, or any other requirement. Do not weaken or remove any
requirement.

The signal tells us what evidence to look for. Use the signal to
choose the keyword for the careers-page search:

- If the signal is about hiring, use a hiring-related keyword from
  the signal (for example, a role name such as "security engineer"
  or "chef" or "developer").
- If the signal is about expansion, use an expansion-related keyword
  from the signal.
- If the signal is about incidents, use an incident-related keyword
  from the signal.
- If the signal is about compliance, use a compliance-related keyword
  from the signal.
- If the signal is about adoption, use an adoption-related keyword
  from the signal.

The signal determines the keyword, but the page type is always a
careers page.

When the location is non-English-speaking, include one search phrase
in the local language of that location. For example, if the location
is in a country whose primary language is not English, use that
language for one of the ten searches. Combine the target and location
in the local language, and may also include a local-language keyword
from the signal or industry.

Use forward-looking and investigative language. The search phrases
describe what to search for, not the results of any search.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Do not:

- invent information that is not present in the summary
- guess missing information
- change any value
- add recommendations or evidence
- add confidence scores
- invent unnecessary details

Return only valid JSON using exactly this format:

{
  "searches": ["the first search phrase", "the second search phrase"]
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
`;

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

// Reads requestedQuantity from the summary allocation, if present.
// Returns null when the value is missing or not a positive integer.

function readRequestedQuantity(summary) {
    if (!summary || typeof summary !== 'object') return null;

    const allocation = summary.allocation;

    if (!allocation || typeof allocation !== 'object') return null;

    const q = allocation.requestedQuantity;

    if (!Number.isInteger(q) || q <= 0) return null;

    return q;
}

// ────────────────────────────────────────────────────────────────
// GENERATION REQUEST
// ────────────────────────────────────────────────────────────────

async function generationRequest(summary, options = {}) {
    console.log('[GenerationRequest] Started');
    console.log('[GenerationRequest] Received summary:', summary);

    const requestedQuantity = readRequestedQuantity(summary);

    console.log(
        '[GenerationRequest] Requested quantity:',
        requestedQuantity
    );

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[GenerationRequest] Attempt ${attempt}/${MAX_ATTEMPTS}`
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
                        content: `Summary output:\n${JSON.stringify(
                            summary,
                            null,
                            2
                        )}`,
                    },
                ],
            });

            console.log(
                '[GenerationRequest] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[GenerationRequest] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[GenerationRequest] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[GenerationRequest] Parsed model response:',
                parsedResult
            );

            const rawSearches = parsedResult?.searches;

            const searches =
                Array.isArray(rawSearches)
                    ? rawSearches
                          .filter(
                              (s) =>
                                  typeof s === 'string' &&
                                  s.trim().length > 0
                          )
                          .map((s) => s.trim())
                    : [];

            if (searches.length > 0) {
                const result = {
                    searches,

                    allocation:
                        summary && typeof summary === 'object'
                            ? summary.allocation
                            : null,
                };

                console.log(
                    '[GenerationRequest] Final result:',
                    result
                );

                return result;
            }

            console.warn(
                '[GenerationRequest] No valid searches returned'
            );
        } catch (error) {
            console.error(
                `[GenerationRequest] Attempt ${attempt} failed`
            );

            console.error(
                '[GenerationRequest] Error name:',
                error.name
            );
            console.error(
                '[GenerationRequest] Error message:',
                error.message
            );
            console.error(
                '[GenerationRequest] Error status:',
                error.status
            );
            console.error(
                '[GenerationRequest] Full error:',
                error
            );
        }
    }

    // Fallback after all attempts fail.
    // The entire output is replaced with the friendly message.
    const fallbackResult = {
        message: FALLBACK_MESSAGE,
    };

    console.warn(
        '[GenerationRequest] All attempts failed. Using fallback:',
        fallbackResult
    );

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = generationRequest;
