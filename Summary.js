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
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given two completed outputs:

1. The Understanding output — what the user wants.
2. The Planning output — how the search should be approached.

Your only task is to write one plain-text summary that describes everything
contained in both outputs.

The summary must include every field from both outputs. Nothing is dropped.
Nothing is added. Nothing is changed.

The Understanding output contains:

- targetEntity  — the type of entity the user is looking for
- problem       — the problem, need, or area of interest connected to it
- intent        — the purpose behind the search
- location      — the city and country of the search
- industry      — the business category
- qualification — the rule or requirement the entities must meet
- signal        — the evidence to investigate
- quantity      — the requested number of leads
- information   — the data fields the pipeline must collect
- exclusions    — what must be left out
- constraints   — the special rules to follow

The Planning output contains:

- strategy        — the overall search approach
- source          — the types of sources to investigate
- query           — the search phrases to send
- evidenceSearch  — the searches to investigate the signal
- allocation      — the maximum number of search calls allowed
- searchExpansion — what to change or try next if the first round is not enough

Write the summary as a clear, complete, plain-text description of what these
two outputs say.

Use forward-looking and investigative language. Describe what the search is
about, what it is looking for, where it is looking, what qualifies, what
evidence matters, what must be excluded, what constraints apply, how the
search is planned, what searches are planned, how many search calls are
allowed, and what to do if the first round is not enough.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Do not:

- invent information that is not present in the two outputs
- guess missing information
- change any value
- drop any field
- add recommendations or evidence
- add confidence scores
- add any extra details

Return only valid JSON using exactly this format:

{
  "summary": "the plain-text summary of everything in the Understanding and Planning outputs"
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
Do not invent unnecessary details.
`;

// ────────────────────────────────────────────────────────────────
// SUMMARY REQUEST
// ────────────────────────────────────────────────────────────────

async function summaryRequest(understanding, planning) {
    console.log('[SummaryRequest] Started');
    console.log(
        '[SummaryRequest] Received understanding:',
        understanding
    );
    console.log('[SummaryRequest] Received planning:', planning);

    const allocation =
        planning && typeof planning === 'object'
            ? planning.allocation
            : undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[SummaryRequest] Attempt ${attempt}/${MAX_ATTEMPTS}`
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
                        )}\n\nPlanning output:\n${JSON.stringify(
                            planning,
                            null,
                            2
                        )}`,
                    },
                ],
            });

            console.log(
                '[SummaryRequest] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[SummaryRequest] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[SummaryRequest] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[SummaryRequest] Parsed model response:',
                parsedResult
            );

            const summary = parsedResult?.summary;

            if (
                typeof summary === 'string' &&
                summary.trim().length > 0
            ) {
                const result = {
                    summary: summary.trim(),
                    allocation:
                        allocation === undefined ? null : allocation,
                };

                console.log('[SummaryRequest] Final result:', result);

                return result;
            }

            console.warn(
                '[SummaryRequest] No valid summary returned'
            );
        } catch (error) {
            console.error(
                `[SummaryRequest] Attempt ${attempt} failed`
            );

            console.error(
                '[SummaryRequest] Error name:',
                error.name
            );
            console.error(
                '[SummaryRequest] Error message:',
                error.message
            );
            console.error(
                '[SummaryRequest] Error status:',
                error.status
            );
            console.error('[SummaryRequest] Full error:', error);
        }
    }

    // Fallback: no summary is invented. The summary is empty.
    // The allocation is still copied verbatim from the Planning output.
    const fallbackResult = {
        summary: '',
        allocation: allocation === undefined ? null : allocation,
    };

    console.warn(
        '[SummaryRequest] All attempts failed. Using fallback:',
        fallbackResult
    );

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = summaryRequest;
