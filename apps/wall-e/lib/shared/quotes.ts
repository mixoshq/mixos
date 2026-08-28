/**
 * The whole database.
 *
 * Thirty-one lines from WALL·E, held in code rather than in a table because
 * thirty-one rows nobody edits at runtime is not a database — it is an array
 * that would like to be deployed. Adding a quote is a one-line change here;
 * see `plans/20260826_2013-quote-of-the-day-widget.md` for why.
 *
 * Wording is faithful-as-remembered rather than transcribed from the script,
 * which is exactly the kind of thing that is cheap to correct in one file.
 */

export interface Quote {
  /** The line itself, without surrounding quotation marks. */
  readonly text: string;
  /** Who says it. Rendered as the byline, so it should read well after an em dash. */
  readonly character: string;
}

export const QUOTES: readonly Quote[] = [
  { text: "I don't want to survive. I want to live!", character: "Captain McCrea" },
  { text: "Out there is our home. Home, EVE. And it's in trouble.", character: "Captain McCrea" },
  { text: "Computer, define dancing.", character: "Captain McCrea" },
  { text: "Define 'farming.'", character: "Captain McCrea" },
  { text: "Define 'sea.'", character: "Captain McCrea" },
  { text: "Define 'hoedown.'", character: "Captain McCrea" },
  { text: "Define 'Earth.'", character: "Captain McCrea" },
  { text: "Wait — this isn't trash. It's a plant.", character: "Captain McCrea" },
  { text: "We have to go back.", character: "Captain McCrea" },
  { text: "On the Axiom, you will survive.", character: "AUTO" },
  { text: "Not to worry.", character: "AUTO" },
  { text: "Directive A-113.", character: "AUTO" },
  { text: "Stay the course.", character: "Shelby Forthright" },
  { text: "Too much garbage in your face? There's plenty of space out in space!", character: "Buy N Large" },
  { text: "Buy N Large: everything you need to be happy.", character: "Buy N Large" },
  { text: "Welcome aboard the Axiom. Enjoy your stay.", character: "Axiom announcer" },
  { text: "Try blue! It's the new red!", character: "Axiom announcer" },
  { text: "Time for lunch. In a cup!", character: "Axiom announcer" },
  { text: "EEE-VAAA!", character: "WALL·E" },
  { text: "WALL·E.", character: "WALL·E" },
  { text: "Ta-da!", character: "WALL·E" },
  { text: "Whoaaa!", character: "WALL·E" },
  { text: "Directive?", character: "WALL·E" },
  { text: "WALL·E!", character: "EVE" },
  { text: "Classified.", character: "EVE" },
  { text: "Foreign contaminant!", character: "M-O" },
  { text: "I didn't know we had a pool!", character: "Mary" },
  { text: "Whoa. Look at that.", character: "John" },
  { text: "Put on your Sunday clothes, there's lots of world out there.", character: "Hello, Dolly!" },
  { text: "It only takes a moment to be loved a whole life long.", character: "Hello, Dolly!" },
  { text: "Out there, there's a world outside of Yonkers.", character: "Hello, Dolly!" },
];

const MS_PER_DAY = 86_400_000;

/**
 * The quote for a given day, chosen by rotation rather than by hash.
 *
 * Deliberately a pure function of the UTC date: the caller is an API route, so
 * one clock decides and everyone in the tenant reads the same line today. A
 * date computed in the browser instead would diverge by timezone and mismatch
 * on hydrate — see the plan for the long version.
 *
 * Rotation, not `Math.random()` and not a hash: it is stable within the day
 * without storing anything, and adding a quote reshuffles the future rather
 * than corrupting state that does not exist.
 */
export function pickQuoteForDate(date: Date): Quote {
  const dayIndex = Math.floor(date.getTime() / MS_PER_DAY);
  // `%` is remainder, not modulo — it goes negative for pre-1970 dates. That is
  // unreachable here (the argument is always `new Date()`), but an out-of-range
  // index would be an undefined dereference rather than a wrong quote, so it is
  // not worth leaving to trust.
  const index = ((dayIndex % QUOTES.length) + QUOTES.length) % QUOTES.length;
  return QUOTES[index]!;
}
