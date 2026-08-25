/**
 * CORS for the OAuth discovery documents.
 *
 * `*` is correct here and only here: these two documents are public endpoint
 * metadata with no user data, no credentials, and no state, and browser-based
 * MCP clients (claude.ai) fetch them cross-origin before any token exists.
 * The token, authorize, and MCP endpoints do NOT get this treatment.
 */
export const WELL_KNOWN_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};
