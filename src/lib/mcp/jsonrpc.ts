/**
 * Minimal JSON-RPC 2.0 framing for the MCP endpoint.
 *
 * We implement the protocol by hand rather than pulling in
 * `@modelcontextprotocol/sdk`: its Streamable HTTP transport is written against
 * Node's `IncomingMessage`/`ServerResponse`, while Next 16 route handlers get a
 * Web `Request` — adapting it is more code than the five methods MixOS actually
 * serves (`initialize`, `notifications/initialized`, `ping`, `tools/list`,
 * `tools/call`). Protocol correctness is verified against MCP Inspector, not
 * assumed. See docs/apps/mcp.md.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Absent for notifications — the client expects no response. */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Standard JSON-RPC 2.0 error codes. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/**
 * Shape-check a decoded JSON value as a JSON-RPC request. Deliberately lenient
 * about `id` type (clients send both strings and numbers) and strict about
 * `method`, which is what we dispatch on.
 */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0") return false;
  if (typeof v.method !== "string" || v.method.length === 0) return false;
  if ("id" in v) {
    const t = typeof v.id;
    if (t !== "string" && t !== "number" && v.id !== null) return false;
  }
  return true;
}

/** A notification carries no `id` and must not be answered. */
export function isNotification(req: JsonRpcRequest): boolean {
  return !("id" in req) || req.id === undefined;
}
