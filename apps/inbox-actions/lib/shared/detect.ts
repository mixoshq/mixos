/**
 * Find the action items in an email body.
 *
 * WHY THIS IS RULES AND NOT A MODEL. App code on this platform has no LLM: no
 * `anthropic`/`openai` connector exists and `context` exposes no model client.
 * "Does this email ask me to do something" therefore has to be answered by
 * deterministic text analysis.
 *
 * That is a real limitation, so the design leans into the one thing rules do
 * better than a model: they can show their work. Every detection carries the
 * SENTENCE IT MATCHED, and the UI renders it. A reader never has to trust a
 * badge — they see "2 action items" and the two lines, and can disagree in a
 * glance. A heuristic with its evidence on screen is useful; the same heuristic
 * hidden behind a number is a liability.
 *
 * Bump `DETECTOR_VERSION` whenever the rules below change. It is stamped onto
 * every row, so a rules change is visible in the data rather than silently
 * mixed in with detections made under the old rules.
 *
 * This module is client-safe on purpose — it imports nothing — so the page and
 * the sync agree on the types, and the rules can be reasoned about in one place.
 */

export const DETECTOR_VERSION = 1;

/** How the sentence asks. Ordered by how explicit the ask is. */
export type ActionKind = "assignment" | "request" | "question";

export interface ActionItem {
  kind: ActionKind;
  /** The matched sentence, trimmed and length-capped. The evidence. */
  text: string;
  /** The sentence also named a date, a deadline, or an urgency cue. */
  hasDeadline: boolean;
}

export interface Detection {
  /** The first `MAX_STORED_ACTIONS` matches, in the order they appear. */
  actions: ActionItem[];
  /** Every match found, which may exceed `actions.length`. */
  actionCount: number;
  hasDeadline: boolean;
}

/** Stop scanning here. A 200-sentence mail is a newsletter, not a request. */
const MAX_SENTENCES = 200;
/** Keep the payload small; the UI shows a "+N more" when the count exceeds it. */
const MAX_STORED_ACTIONS = 6;
/** A "sentence" longer than this is a wall of text, not an ask worth quoting. */
const MAX_SENTENCE_CHARS = 240;

// -- Sentence-level noise ---------------------------------------------------

/**
 * Sentences that look like asks but are footer furniture. Without these, every
 * marketing mail scores three or four "action items" and the badge stops
 * meaning anything — which is the failure mode that makes a flag like this
 * worthless.
 */
const NOISE = [
  /\bunsubscribe\b/i,
  /\bno[-\s]?reply\b/i,
  /\bdo not reply\b/i,
  /\bview (this|it) (email )?in (your )?browser\b/i,
  /\bmanage (your )?(email )?(preferences|subscriptions?)\b/i,
  /\bupdate your preferences\b/i,
  /\bprivacy (policy|notice)\b/i,
  /\bterms of (service|use)\b/i,
  /\ball rights reserved\b/i,
  /\bconfidential(ity)?\b.*\b(notice|intended recipient)\b/i,
  /\bif you (are not|have received) th(is|e)\b/i,
  /\bsent from my (iphone|ipad|android|mobile)\b/i,
  // Closing boilerplate. "Let me know if you have any questions" is a sign-off,
  // not a task, and it appears at the bottom of a large share of business mail.
  /\b(please )?(let (me|us) know|feel free to (reach out|contact|ask))\b.*\bif you (have|need)\b/i,
  /\bplease (note|find|see|disregard|ignore)\b/i,
  /\bplease (do not|don't)\b/i,
  /\bplease contact (us|support|your)\b/i,
];

// -- Triggers, most explicit first ------------------------------------------

/** Somebody has been handed a task by name. */
const ASSIGNMENT = [
  /\baction (required|requested|item|needed)\b/i,
  /\b(to-?do|todo)\b:/i,
  /\bassigned to you\b/i,
  /\byou('| a)?re responsible for\b/i,
  /\byou (need|have) to\b/i,
  /\byou'll need to\b/i,
  /\bneeds? your (approval|signature|sign[-\s]?off|attention|input|review|response|reply)\b/i,
  /\bawaiting your\b/i,
  /\brequires? your\b/i,
  /\bfor your (approval|review|signature|action)\b/i,
];

/** Somebody is being asked, politely or otherwise. */
const REQUEST = [
  /\b(can|could|would|will)\s+you\b/i,
  /\bwould you mind\b/i,
  /\bany chance you (could|can)\b/i,
  /\bi('d| would)? (need|like) you to\b/i,
  /\bi need (you|someone) to\b/i,
  /\bwe need (you|someone) to\b/i,
  // A bare imperative "please <verb>". The noise list above has already removed
  // "please note/find/see/disregard/ignore/do not/contact us", which is what
  // separates a request from a courtesy.
  /\bplease\s+[a-z]{2,}/i,
  /\bkindly\s+[a-z]{2,}/i,
];

/**
 * A question aimed at the reader. Requires either second person or a leading
 * interrogative — "?" alone matches rhetorical newsletter copy ("Ready to save
 * 40%?") far more often than it matches a real ask.
 */
const SECOND_PERSON = /\b(you|your|yours|we|us|our)\b/i;
const INTERROGATIVE =
  /^(are|is|was|were|do|does|did|can|could|will|would|should|shall|have|has|had|when|what|which|who|whom|whose|where|why|how|any)\b/i;

/** Date, deadline and urgency cues. A modifier, never a trigger on its own. */
const DEADLINE = [
  /\bby (mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b/i,
  /\bby (today|tomorrow|tonight|noon|midnight|eod|eob|cob)\b/i,
  /\bby (the )?(end of|close of)\b/i,
  /\bby \d{1,2}(st|nd|rd|th)?\b/i,
  /\bby (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /\bbefore (mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun|today|tomorrow|noon|eod|eob|cob|the end of)/i,
  /\b(due|deadline)\b/i,
  /\bno later than\b/i,
  /\bwithin \d+ (minutes?|hours?|days?|weeks?|business days?)\b/i,
  /\basap\b/i,
  /\bas soon as possible\b/i,
  /\burgent(ly)?\b/i,
];

const matchesAny = (patterns: RegExp[], s: string): boolean =>
  patterns.some((p) => p.test(s));

// -- Body extraction --------------------------------------------------------

/**
 * Turn an HTML body into something sentence-splittable.
 *
 * Only used when the message has no `text/plain` part. Block-level tags become
 * newlines so a list of bullets doesn't run together into one 900-character
 * "sentence" that then gets discarded for being too long.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t\u00a0]+/g, " ");
}

/**
 * Drop quoted history and the signature block.
 *
 * This is the single most valuable step in the whole extractor. Without it every
 * reply in a long thread inherits every ask ever made in that thread, so the
 * newest message in a 12-mail chain shows the most action items — exactly
 * inverted from what a reader wants. A short "Thanks, done!" reply on top of a
 * thread full of requests must read as zero actions, and this is what makes it.
 */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Everything from an attribution line down is somebody else's message.
    if (
      /^on\b.*\bwrote:\s*$/i.test(trimmed) ||
      /^-{2,}\s*original message\s*-{2,}$/i.test(trimmed) ||
      /^_{5,}$/.test(trimmed) ||
      /^from:\s*.+/i.test(trimmed) ||
      /^-{2,}\s*forwarded message\s*-{2,}$/i.test(trimmed)
    ) {
      break;
    }
    // The RFC 3676 signature delimiter: "-- " alone on a line.
    if (/^--\s*$/.test(line)) break;
    // Quoted lines, at any depth.
    if (/^\s*>+/.test(line)) continue;

    kept.push(line);
  }

  return kept.join("\n");
}

/**
 * Split into candidate sentences on terminal punctuation AND newlines.
 *
 * Newlines matter as much as full stops here: a bulleted list of asks is the
 * most action-dense shape an email takes, and bullets rarely end in a period.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((s) => s.replace(/^[\s*\-\u2013\u2014\u2022\u00b7\d.)\]]+/, "").trim())
    .filter((s) => s.length >= 8);
}

function classify(sentence: string): ActionKind | null {
  if (matchesAny(ASSIGNMENT, sentence)) return "assignment";
  if (matchesAny(REQUEST, sentence)) return "request";
  if (
    sentence.endsWith("?") &&
    (SECOND_PERSON.test(sentence) || INTERROGATIVE.test(sentence))
  ) {
    return "question";
  }
  return null;
}

// -- The entry point --------------------------------------------------------

/**
 * Detect the action items in one message.
 *
 * Prefers the plain-text part, falls back to HTML, and falls back again to
 * Gmail's snippet — which is short and unquoted, so it is a poor but non-zero
 * signal rather than nothing at all.
 */
export function detectActionItems(body: {
  text?: string | null;
  html?: string | null;
  snippet?: string | null;
}): Detection {
  const raw =
    body.text?.trim() ||
    (body.html ? htmlToText(body.html).trim() : "") ||
    body.snippet?.trim() ||
    "";

  if (!raw) return { actions: [], actionCount: 0, hasDeadline: false };

  const sentences = splitSentences(stripQuoted(raw)).slice(0, MAX_SENTENCES);

  const actions: ActionItem[] = [];
  let actionCount = 0;
  let hasDeadline = false;

  for (const sentence of sentences) {
    if (sentence.length > MAX_SENTENCE_CHARS) continue;
    if (matchesAny(NOISE, sentence)) continue;

    const kind = classify(sentence);
    if (!kind) continue;

    actionCount++;
    const sentenceHasDeadline = matchesAny(DEADLINE, sentence);
    if (sentenceHasDeadline) hasDeadline = true;

    if (actions.length < MAX_STORED_ACTIONS) {
      actions.push({ kind, text: sentence, hasDeadline: sentenceHasDeadline });
    }
  }

  return { actions, actionCount, hasDeadline };
}

/** Split a `From:` header into a display name and a bare address. */
export function parseFrom(from: string | null): {
  name: string | null;
  email: string | null;
} {
  if (!from) return { name: null, email: null };

  const angled = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].replace(/^["']|["']$/g, "").trim();
    return { name: name || null, email: angled[2].trim().toLowerCase() };
  }

  const bare = from.trim();
  return {
    name: null,
    email: bare.includes("@") ? bare.toLowerCase() : null,
  };
}
