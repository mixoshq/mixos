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
  {
    text: "I don't want to survive. I want to live!",
    character: "Captain McCrea",
  },
  {
    text: "Out there is our home. Home, EVE. And it's in trouble.",
    character: "Captain McCrea",
  },
  { text: "Computer, define dancing.", character: "Captain McCrea" },
  { text: "Define 'farming.'", character: "Captain McCrea" },
  { text: "Define 'sea.'", character: "Captain McCrea" },
  { text: "Define 'hoedown.'", character: "Captain McCrea" },
  { text: "Define 'Earth.'", character: "Captain McCrea" },
  {
    text: "Wait — this isn't trash. It's a plant.",
    character: "Captain McCrea",
  },
  { text: "We have to go back.", character: "Captain McCrea" },
  { text: "On the Axiom, you will survive.", character: "AUTO" },
  { text: "Not to worry.", character: "AUTO" },
  { text: "Directive A-113.", character: "AUTO" },
  { text: "Stay the course.", character: "Shelby Forthright" },
  {
    text: "Too much garbage in your face? There's plenty of space out in space!",
    character: "Buy N Large",
  },
  {
    text: "Buy N Large: everything you need to be happy.",
    character: "Buy N Large",
  },
  {
    text: "Welcome aboard the Axiom. Enjoy your stay.",
    character: "Axiom announcer",
  },
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
  {
    text: "Put on your Sunday clothes, there's lots of world out there.",
    character: "Hello, Dolly!",
  },
  {
    text: "It only takes a moment to be loved a whole life long.",
    character: "Hello, Dolly!",
  },
  {
    text: "Out there, there's a world outside of Yonkers.",
    character: "Hello, Dolly!",
  },
];

const MS_PER_HOUR = 3_600_000;

/**
 * The line for the hour `date` falls in.
 *
 * RANDOM, BUT NOT RANDOMISED PER REQUEST. The choice is derived from the hour,
 * so it is unpredictable in order — you cannot tell which line is next — while
 * everyone who asks within the same hour gets the same answer. `Math.random()`
 * here would hand a different line to every request, which means the widget
 * changing under you when you navigate, two browsers disagreeing, and no
 * answer to "when does it change?". Hourly and stable is the thing being asked
 * for; unpredictable is the flavour.
 *
 * A SHUFFLED CYCLE, NOT A HASH PER HOUR. Hashing each hour independently looks
 * random and behaves worse than it looks: with 31 lines it repeats the
 * previous hour about once a day (a collision is 1-in-31, every hour), and
 * over a year some lines come up a third more often than others. Instead each
 * run of 31 hours is a fresh shuffle of all 31 lines, seeded by which run it
 * is. Every line appears exactly once per run, the order is different every
 * run, and the only place a repeat could hide — the seam between two runs — is
 * closed by `orderForCycle`.
 */
export function pickQuoteForHour(date: Date): Quote {
  const hour = Math.floor(date.getTime() / MS_PER_HOUR);
  const cycle = Math.floor(hour / QUOTES.length);
  const slot = hour - cycle * QUOTES.length;
  return QUOTES[orderForCycle(cycle)[slot]!]!;
}

/** When the line changes next: the top of the following hour. */
export function nextChangeAfter(date: Date): Date {
  return new Date((Math.floor(date.getTime() / MS_PER_HOUR) + 1) * MS_PER_HOUR);
}

/**
 * The order the lines are shown in during one run of `QUOTES.length` hours.
 *
 * The seam: a run's first line could be the previous run's last, which is the
 * one way this scheme could show the same line twice running. Swapping the
 * first two entries fixes it, and reads as just another shuffle. The previous
 * run is re-derived rather than remembered — it is one shuffle, and a cache
 * here would be state that has to survive a serverless cold start to be worth
 * anything. The previous run's own seam fix only ever touches its first two
 * entries, so its last entry is the same either way and one level is enough.
 */
function orderForCycle(cycle: number): number[] {
  const order = shuffledIndices(cycle);
  const previous = shuffledIndices(cycle - 1);
  if (order[0] === previous[previous.length - 1]) {
    [order[0], order[1]] = [order[1]!, order[0]!];
  }
  return order;
}

/** `[0 … QUOTES.length - 1]`, Fisher-Yates shuffled with `seed`. */
function shuffledIndices(seed: number): number[] {
  const random = seededRandom(seed);
  const out = Array.from({ length: QUOTES.length }, (_, i) => i);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A small deterministic PRNG (mulberry32). Deterministic is the point: the
 * same hour must produce the same line on every server, on every request,
 * forever — so this cannot be `Math.random`, and a seed of `0` has to behave
 * like any other seed rather than degenerating.
 */
function seededRandom(seed: number): () => number {
  let state = (seed + 0x9e3779b9) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
