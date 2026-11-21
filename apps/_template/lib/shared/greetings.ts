/**
 * A handful of greetings, kept in code so the example needs no database.
 *
 * Shared by the search handler (search/greetings.ts), which finds them, and
 * the page it links to (pages/greetings/Main.tsx), which shows them — so the
 * two can never disagree about what a greeting's id names. A real app reads
 * these from `context.db` or a connector instead.
 */
export interface Greeting {
  /** Stable, and what `{id}` in the search link is filled with. */
  id: string;
  phrase: string;
  language: string;
}

export const GREETINGS: readonly Greeting[] = [
  { id: "en", phrase: "Hello", language: "English" },
  { id: "es", phrase: "Hola", language: "Spanish" },
  { id: "fr", phrase: "Bonjour", language: "French" },
  { id: "de", phrase: "Hallo", language: "German" },
  { id: "it", phrase: "Ciao", language: "Italian" },
  { id: "pt", phrase: "Olá", language: "Portuguese" },
  { id: "nl", phrase: "Hallo", language: "Dutch" },
  { id: "sv", phrase: "Hej", language: "Swedish" },
  { id: "fi", phrase: "Hei", language: "Finnish" },
  { id: "pl", phrase: "Cześć", language: "Polish" },
  { id: "tr", phrase: "Merhaba", language: "Turkish" },
  { id: "sw", phrase: "Habari", language: "Swahili" },
  { id: "haw", phrase: "Aloha", language: "Hawaiian" },
  { id: "ja", phrase: "Konnichiwa", language: "Japanese" },
  { id: "hi", phrase: "Namaste", language: "Hindi" },
  { id: "he", phrase: "Shalom", language: "Hebrew" },
  { id: "ar", phrase: "Marhaba", language: "Arabic" },
  { id: "ga", phrase: "Dia duit", language: "Irish" },
];
