// ────────────────────────────────────────────────────────────────
// Searching.js — Company Data Extraction and Lead Generation
// ────────────────────────────────────────────────────────────────
'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';
const MAX_AI_ATTEMPTS = 4;
const MAX_EXTRACT_ATTEMPTS = 4;
const MAX_SEARCH_FALLBACK_ATTEMPTS = 4;

const MAX_CONTENT_CHARS = 120000;

const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';

const TAVILY_EXTRACT_PARAMS = {
    extract_depth: 'advanced',
    format: 'markdown',
    timeout: 60,
    include_usage: true,
    query: 'contact email phone number address company information',
    chunks_per_source: 5,
};

const TAVILY_SEARCH_FALLBACK_PARAMS = {
    search_depth: 'advanced',
    max_results: 5,
    include_raw_content: true,
    include_answer: false,
    include_favicon: false,
    topic: 'general',
};

const TAVILY_EMAIL_SEARCH_PARAMS = {
    search_depth: 'advanced',
    max_results: 5,
    include_raw_content: true,
    include_answer: false,
    include_favicon: false,
    topic: 'general',
};

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// REGEX PRE-SCAN FOR CONTACT CANDIDATES
// ────────────────────────────────────────────────────────────────

const EMAIL_REGEX_PLAIN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const EMAIL_REGEX_OBFUSCATED =
    /[a-zA-Z0-9._%+-]+\s*[\[\(\{]\s*at\s*[\]\)\}]\s*[a-zA-Z0-9.-]+\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*[a-zA-Z]{2,}/gi;

const EMAIL_REGEX_HTML_ENTITY =
    /[a-zA-Z0-9._%+-]+&#64;[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const EMAIL_REGEX_MAILTO =
    /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

const PHONE_REGEXES = [
    /\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
    /\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/g,
    /\d{3}[-.\s]\d{3}[-.\s]\d{4}/g,
];

// Vanity phone numbers — 1-800-FLOWERS, (800) CALL-NOW, 800-GOT-JUNK.
// Matches a phone-shaped pattern with 2+ letter groups separated by
// dashes, dots, spaces, or parens.
const VANITY_PHONE_REGEX =
    /\b(?:1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?[A-Za-z]{2,}[\s.-]?[A-Za-z]{2,}(?:[\s.-]?[A-Za-z]{2,})?\b/g;

const EMAIL_BLACKLIST_SUBSTRINGS = [
    'example.com',
    'sentry.io',
    'wixpress.com',
    'placeholder',
    'your-email',
    'youremail',
    'your.name',
    'name@',
    'email@',
    'domain.com',
];

const PHONE_BLACKLIST_SUBSTRINGS = [
    '000-000-0000',
    '123-456-7890',
    '111-111-1111',
];

// ────────────────────────────────────────────────────────────────
// VANITY PHONE → DIGITS
// ────────────────────────────────────────────────────────────────

// Standard phone keypad mapping.
const LETTER_TO_DIGIT = {
    A: '2', B: '2', C: '2',
    D: '3', E: '3', F: '3',
    G: '4', H: '4', I: '4',
    J: '5', K: '5', L: '5',
    M: '6', N: '6', O: '6',
    P: '7', Q: '7', R: '7', S: '7',
    T: '8', U: '8', V: '8',
    W: '9', X: '9', Y: '9', Z: '9',
};

// Converts every letter in a phone string to its dialable digit.
// Leaves digits, dashes, dots, spaces, parens, plus, and other
// non-letter characters unchanged.
function convertVanityPhoneToDigits(phone) {
    if (typeof phone !== 'string' || phone.length === 0) {
        return phone;
    }

    return phone.replace(/[A-Za-z]/g, (ch) => {
        const digit = LETTER_TO_DIGIT[ch.toUpperCase()];
        return digit || ch;
    });
}

// ────────────────────────────────────────────────────────────────
// EMAIL NORMALIZATION
// ────────────────────────────────────────────────────────────────

function normalizeEmail(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return null;
    }

    let email = raw.trim();

    if (/^mailto:/i.test(email)) {
        email = email.replace(/^mailto:/i, '');
    }

    email = email.replace(/\s*[\[\(\{]\s*at\s*[\]\)\}]\s*/gi, '@');
    email = email.replace(/\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*/gi, '.');
    email = email.replace(/&#64;/g, '@');
    email = email.replace(/\s+/g, '');

    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
        return null;
    }

    return email.toLowerCase();
}

// ────────────────────────────────────────────────────────────────
// CONTACT SCAN
// ────────────────────────────────────────────────────────────────

function scanForContactCandidates(content) {
    if (typeof content !== 'string' || content.length === 0) {
        return { emails: [], phones: [] };
    }

    const emailSet = new Set();

    const emailPatterns = [
        EMAIL_REGEX_PLAIN,
        EMAIL_REGEX_OBFUSCATED,
        EMAIL_REGEX_HTML_ENTITY,
        EMAIL_REGEX_MAILTO,
    ];

    for (const pattern of emailPatterns) {
        pattern.lastIndex = 0;
        const matches = content.match(pattern) || [];

        for (const raw of matches) {
            const email = normalizeEmail(raw);

            if (!email) continue;
            if (email.length > 80) continue;

            const isBlacklisted = EMAIL_BLACKLIST_SUBSTRINGS.some((b) =>
                email.includes(b)
            );
            if (isBlacklisted) continue;

            emailSet.add(email);
            if (emailSet.size >= 15) break;
        }

        if (emailSet.size >= 15) break;
    }

    const phoneSet = new Set();

    // ── Pass 1: numeric phone numbers ──
    for (const regex of PHONE_REGEXES) {
        regex.lastIndex = 0;
        const matches = content.match(regex) || [];

        for (const raw of matches) {
            const phone = raw.trim();

            if (phone.includes('@')) continue;

            const digitCount = (phone.match(/\d/g) || []).length;
            if (digitCount < 10 || digitCount > 15) continue;

            const isBlacklisted = PHONE_BLACKLIST_SUBSTRINGS.some((b) =>
                phone.includes(b)
            );
            if (isBlacklisted) continue;

            phoneSet.add(phone);
            if (phoneSet.size >= 10) break;
        }

        if (phoneSet.size >= 10) break;
    }

    // ── Pass 2: vanity phone numbers → convert to digits ──
    if (phoneSet.size < 10) {
        VANITY_PHONE_REGEX.lastIndex = 0;
        const vanityMatches = content.match(VANITY_PHONE_REGEX) || [];

        for (const raw of vanityMatches) {
            const converted = convertVanityPhoneToDigits(raw.trim());

            // Sanity: converted form must have 10–15 digits.
            const digitCount = (converted.match(/\d/g) || []).length;
            if (digitCount < 10 || digitCount > 15) continue;

            const isBlacklisted = PHONE_BLACKLIST_SUBSTRINGS.some((b) =>
                converted.includes(b)
            );
            if (isBlacklisted) continue;

            phoneSet.add(converted);
            if (phoneSet.size >= 10) break;
        }
    }

    return {
        emails: Array.from(emailSet),
        phones: Array.from(phoneSet),
    };
}

// ────────────────────────────────────────────────────────────────
// AI INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the extracted content from several pages of a single
company's official website, plus a list of contact-data candidates
that were pre-scanned from that content using regular expressions.

Your task is to identify four pieces of information about the company:

1. Company name
2. Company email address
3. Company information (a short description)
4. Company phone number

Read all the extracted content carefully. The pages belong to one
company. Do not mix in information about any other company.

Pre-scanned candidates:

The pre-scanned email list contains every literal email address that
appears in the content, including obfuscated forms normalized to plain
email. The pre-scanned phone list contains every literal phone number
that appears in the content. Vanity phone numbers have already been
converted to digits.

These are literal matches from the content — not predictions.

Rules:

Company name:
- Return the official name of the company as it appears on its own
  website.
- If the name cannot be identified, return null.

Company email:
- If a pre-scanned email candidate exists and belongs to the company's
  own domain, return it and set emailStatus to "verified".
- If a pre-scanned email candidate exists but belongs to a third-party
  domain (a vendor, a webmail, a different company), do not return it.
  Prefer a candidate on the company's own domain if one exists.
- If no pre-scanned email candidate belongs to the company's own
  domain, return null and set emailStatus to "not_found".
- Never predict, guess, or invent an email address.
- Never return an email address that does not appear literally in the
  pre-scanned candidates.

Company information:
- If the content describes the company, write a short description
  based only on that content, and set informationStatus to "verified".
- If the content does not describe the company but a tentative summary
  is reasonable, write a short tentative description, and set
  informationStatus to "estimated".
- Do not invent specific facts.

Company phone number:
- If a pre-scanned phone candidate exists and is plausible for the
  company, return it.
- If no pre-scanned phone candidate exists, return null.
- Never guess or invent a phone number.

Return only valid JSON using exactly this format:

{
  "companyName": "the official company name or null",
  "email": "the email address or null",
  "emailStatus": "verified" | "not_found",
  "companyInformation": "short description",
  "informationStatus": "verified" | "estimated",
  "phoneNumber": "the phone number or null"
}

Do not explain your answer.
Do not add extra fields.
`;

// ────────────────────────────────────────────────────────────────
// TAVILY EXTRACT — BATCH REQUEST WITH RETRIES
// ────────────────────────────────────────────────────────────────

async function runTavilyExtract(urls) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[Searching] TAVILY_API_KEY is not set');
        return null;
    }

    if (!Array.isArray(urls) || urls.length === 0) {
        console.warn('[Searching] No URLs to extract');
        return null;
    }

    for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
        const startMs = Date.now();

        console.log(
            `[Searching] Extract attempt ${attempt}/${MAX_EXTRACT_ATTEMPTS} for ${urls.length} URL(s)`
        );

        try {
            const response = await fetch(TAVILY_EXTRACT_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    urls,
                    ...TAVILY_EXTRACT_PARAMS,
                }),
            });

            const elapsedMs = Date.now() - startMs;

            console.log(
                `[Searching] Extract HTTP status: ${response.status} (${elapsedMs}ms)`
            );

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                console.error(
                    `[Searching] Extract failed with status ${response.status}: ${errorBody}`
                );
                continue;
            }

            const extractResponse = await response.json();

            console.log(
                '[Searching] Extract response — successful:',
                Array.isArray(extractResponse.results)
                    ? extractResponse.results.length
                    : 0,
                'failed:',
                Array.isArray(extractResponse.failed_results)
                    ? extractResponse.failed_results.length
                    : 0
            );

            return extractResponse;
        } catch (error) {
            const elapsedMs = Date.now() - startMs;
            console.error(
                `[Searching] Extract attempt ${attempt} failed (${elapsedMs}ms):`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Searching] All Extract attempts failed');
    return null;
}

// ────────────────────────────────────────────────────────────────
// TAVILY SEARCH FALLBACK — GENERAL FALLBACK
// ────────────────────────────────────────────────────────────────

async function runTavilySearchFallback(domain) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[Searching] TAVILY_API_KEY is not set');
        return null;
    }

    if (!domain || typeof domain !== 'string' || domain.trim().length === 0) {
        console.warn('[Searching] No domain for Search fallback');
        return null;
    }

    for (let attempt = 1; attempt <= MAX_SEARCH_FALLBACK_ATTEMPTS; attempt++) {
        const startMs = Date.now();

        console.log(
            `[Searching] Search fallback attempt ${attempt}/${MAX_SEARCH_FALLBACK_ATTEMPTS} for: ${domain}`
        );

        try {
            const query = `site:${new URL(domain).hostname} contact email phone`;

            const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    query,
                    ...TAVILY_SEARCH_FALLBACK_PARAMS,
                }),
            });

            const elapsedMs = Date.now() - startMs;

            console.log(
                `[Searching] Search fallback HTTP status: ${response.status} (${elapsedMs}ms)`
            );

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                console.error(
                    `[Searching] Search fallback failed with status ${response.status}: ${errorBody}`
                );
                continue;
            }

            const searchResponse = await response.json();

            console.log(
                '[Searching] Search fallback response — results:',
                Array.isArray(searchResponse.results)
                    ? searchResponse.results.length
                    : 0
            );

            return searchResponse;
        } catch (error) {
            const elapsedMs = Date.now() - startMs;
            console.error(
                `[Searching] Search fallback attempt ${attempt} failed (${elapsedMs}ms):`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Searching] All Search fallback attempts failed');
    return null;
}

// ────────────────────────────────────────────────────────────────
// TAVILY EMAIL-TARGETED SEARCH FALLBACK
// ────────────────────────────────────────────────────────────────

async function runTavilyEmailSearch(domain) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[Searching] TAVILY_API_KEY is not set');
        return null;
    }

    if (!domain || typeof domain !== 'string' || domain.trim().length === 0) {
        console.warn('[Searching] No domain for email search');
        return null;
    }

    let hostname;
    try {
        hostname = new URL(domain).hostname.replace(/^www\./i, '');
    } catch (_) {
        return null;
    }

    for (let attempt = 1; attempt <= MAX_SEARCH_FALLBACK_ATTEMPTS; attempt++) {
        const startMs = Date.now();

        console.log(
            `[Searching] Email search attempt ${attempt}/${MAX_SEARCH_FALLBACK_ATTEMPTS} for: ${domain}`
        );

        try {
            const query = `site:${hostname} "@${hostname}"`;

            const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    query,
                    ...TAVILY_EMAIL_SEARCH_PARAMS,
                }),
            });

            const elapsedMs = Date.now() - startMs;

            console.log(
                `[Searching] Email search HTTP status: ${response.status} (${elapsedMs}ms)`
            );

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                console.error(
                    `[Searching] Email search failed with status ${response.status}: ${errorBody}`
                );
                continue;
            }

            const searchResponse = await response.json();

            console.log(
                '[Searching] Email search response — results:',
                Array.isArray(searchResponse.results)
                    ? searchResponse.results.length
                    : 0
            );

            return searchResponse;
        } catch (error) {
            const elapsedMs = Date.now() - startMs;
            console.error(
                `[Searching] Email search attempt ${attempt} failed (${elapsedMs}ms):`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Searching] All email search attempts failed for:', domain);
    return null;
}

// ────────────────────────────────────────────────────────────────
// AI EXTRACTION — ONE CALL PER COMPANY
// ────────────────────────────────────────────────────────────────

async function extractCompanyData(companyName, rawContent) {
    const candidates = scanForContactCandidates(rawContent);

    console.log(
        `[Searching] Pre-scan candidates for ${companyName} — emails: ${candidates.emails.length}, phones: ${candidates.phones.length}`
    );
    if (candidates.emails.length > 0) {
        console.log('[Searching]   email candidates:', candidates.emails);
    }
    if (candidates.phones.length > 0) {
        console.log('[Searching]   phone candidates:', candidates.phones);
    }

    const content =
        rawContent.length > MAX_CONTENT_CHARS
            ? rawContent.slice(0, MAX_CONTENT_CHARS)
            : rawContent;

    for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
        console.log(
            `[Searching] AI attempt ${attempt}/${MAX_AI_ATTEMPTS} for: ${companyName}`
        );

        try {
            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: SYSTEM_INSTRUCTIONS },
                    {
                        role: 'user',
                        content:
                            `Company hint: ${companyName}\n\n` +
                            `Pre-scanned email candidates:\n` +
                            (candidates.emails.length > 0
                                ? candidates.emails.map((e) => `- ${e}`).join('\n')
                                : '(none)') +
                            `\n\nPre-scanned phone candidates:\n` +
                            (candidates.phones.length > 0
                                ? candidates.phones.map((p) => `- ${p}`).join('\n')
                                : '(none)') +
                            `\n\nExtracted content:\n${content}`,
                    },
                ],
            });

            const output = completion.choices?.[0]?.message?.content;
            console.log('[Searching] AI raw response:', output);

            if (!output) {
                console.error('[Searching] AI returned empty content');
                continue;
            }

            const parsed = JSON.parse(output);

            const companyNameOut =
                typeof parsed?.companyName === 'string' &&
                parsed.companyName.trim().length > 0
                    ? parsed.companyName.trim()
                    : null;

            const email =
                typeof parsed?.email === 'string' &&
                parsed.email.trim().length > 0
                    ? parsed.email.trim()
                    : null;

            const emailStatus = email ? 'verified' : 'not_found';

            const companyInformation =
                typeof parsed?.companyInformation === 'string'
                    ? parsed.companyInformation.trim()
                    : '';

            const rawInfoStatus = parsed?.informationStatus;
            const informationStatus =
                rawInfoStatus === 'verified' || rawInfoStatus === 'estimated'
                    ? rawInfoStatus
                    : 'verified';

            // Apply vanity→digits conversion as a safety net in case
            // the AI returned a letter form directly.
            const rawPhone =
                typeof parsed?.phoneNumber === 'string' &&
                parsed.phoneNumber.trim().length > 0
                    ? parsed.phoneNumber.trim()
                    : null;

            const phoneNumber = rawPhone
                ? convertVanityPhoneToDigits(rawPhone)
                : null;

            return {
                companyName: companyNameOut,
                email,
                emailStatus,
                companyInformation,
                informationStatus,
                phoneNumber,
            };
        } catch (error) {
            console.error(
                `[Searching] AI attempt ${attempt} failed:`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Searching] All AI attempts failed for:', companyName);
    return null;
}

// ────────────────────────────────────────────────────────────────
// SEARCHING REQUEST — MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function searchingRequest(contactPagesOutput) {
    const startedAt = Date.now();
    console.log('[Searching] Started');

    if (
        !contactPagesOutput ||
        typeof contactPagesOutput !== 'object' ||
        typeof contactPagesOutput.message === 'string'
    ) {
        console.warn(
            '[Searching] ContactPages output is a fallback message. Returning it.'
        );

        return {
            message:
                (contactPagesOutput && contactPagesOutput.message) ||
                FALLBACK_MESSAGE,
        };
    }

    const pages = Array.isArray(contactPagesOutput.pages)
        ? contactPagesOutput.pages
        : [];

    if (pages.length === 0) {
        console.warn(
            '[Searching] No companies to process. Returning friendly message.'
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    const companies = [];

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const companyStart = Date.now();

        const name =
            typeof page.name === 'string' && page.name.trim().length > 0
                ? page.name.trim()
                : `Company ${i + 1}`;

        console.log(
            `[Searching] Processing company ${i + 1}/${pages.length}: ${name}`
        );

        const urls = Array.isArray(page?.mapResponse?.results)
            ? page.mapResponse.results.filter(
                  (u) => typeof u === 'string' && u.trim().length > 0
              )
            : [];

        let combinedContent = '';
        let usedSearchFallback = false;
        let usedEmailSearch = false;

        if (urls.length > 0) {
            const extractResponse = await runTavilyExtract(urls);

            if (extractResponse) {
                const successfulResults = Array.isArray(extractResponse.results)
                    ? extractResponse.results
                    : [];

                const failedCount = Array.isArray(
                    extractResponse.failed_results
                )
                    ? extractResponse.failed_results.length
                    : 0;

                if (failedCount > 0) {
                    console.warn(
                        `[Searching] ${failedCount} URL(s) failed to extract for ${name} — running Search fallback`
                    );

                    const searchFallback = await runTavilySearchFallback(
                        page.domain
                    );

                    if (searchFallback) {
                        usedSearchFallback = true;

                        const searchResults = Array.isArray(
                            searchFallback.results
                        )
                            ? searchFallback.results
                            : [];

                        for (const r of searchResults) {
                            const raw =
                                typeof r.raw_content === 'string'
                                    ? r.raw_content
                                    : '';
                            if (raw.trim().length > 0) {
                                combinedContent += `\n\n----- ${r.url || 'search result'} -----\n${raw}`;
                            }
                        }
                    }
                }

                for (const r of successfulResults) {
                    const raw =
                        typeof r.raw_content === 'string' ? r.raw_content : '';
                    if (raw.trim().length > 0) {
                        combinedContent += `\n\n----- ${r.url || 'page'} -----\n${raw}`;
                    }
                }
            }
        } else {
            console.warn(
                `[Searching] No URLs for ${name} — running Search fallback`
            );

            const searchFallback = await runTavilySearchFallback(page.domain);

            if (searchFallback) {
                usedSearchFallback = true;

                const searchResults = Array.isArray(searchFallback.results)
                    ? searchFallback.results
                    : [];

                for (const r of searchResults) {
                    const raw =
                        typeof r.raw_content === 'string' ? r.raw_content : '';
                    if (raw.trim().length > 0) {
                        combinedContent += `\n\n----- ${r.url || 'search result'} -----\n${raw}`;
                    }
                }
            }
        }

        if (combinedContent.trim().length === 0) {
            console.warn(
                `[Searching] No usable content for ${name} — skipping`
            );
            continue;
        }

        const initialCandidates = scanForContactCandidates(combinedContent);

        if (initialCandidates.emails.length === 0) {
            console.log(
                `[Searching] No email candidates for ${name} — running targeted email search`
            );

            const emailSearch = await runTavilyEmailSearch(page.domain);

            if (emailSearch) {
                usedEmailSearch = true;

                const emailSearchResults = Array.isArray(
                    emailSearch.results
                )
                    ? emailSearch.results
                    : [];

                for (const r of emailSearchResults) {
                    const raw =
                        typeof r.raw_content === 'string' ? r.raw_content : '';
                    if (raw.trim().length > 0) {
                        combinedContent += `\n\n----- ${r.url || 'email search result'} -----\n${raw}`;
                    }
                }

                const secondCandidates = scanForContactCandidates(
                    combinedContent
                );

                console.log(
                    `[Searching] After email search — emails: ${secondCandidates.emails.length}`
                );
            }
        }

        const record = await extractCompanyData(name, combinedContent);

        if (!record) {
            console.warn(
                `[Searching] AI extraction failed for ${name} — skipping`
            );
            continue;
        }

        if (!record.companyName) {
            record.companyName = name;
        }

        companies.push(record);

        const flags = [];
        if (usedSearchFallback) flags.push('Search fallback');
        if (usedEmailSearch) flags.push('Email search');

        console.log(
            `[Searching] Company ${i + 1} completed (${Date.now() - companyStart}ms)${flags.length ? ` [${flags.join(', ')}]` : ''}`
        );
    }

    if (companies.length === 0) {
        const elapsed = Date.now() - startedAt;
        console.warn(
            `[Searching] No companies succeeded (${elapsed}ms). Returning friendly message.`
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    const elapsed = Date.now() - startedAt;

    console.log(
        `[Searching] Finished — ${companies.length}/${pages.length} companies succeeded in ${elapsed}ms`
    );

    return {
        companies,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = searchingRequest;
