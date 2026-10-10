/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AppClientError,
  connectorErrorOf,
  createAppClient,
  type ConnectorErrorEnvelope,
} from "@/lib/apps/sdk";

/**
 * Fetch from one of this app's declared routes, with every state a fetch can be
 * in modelled explicitly.
 *
 * The four states are a discriminated union rather than three loose booleans,
 * because `loading && error` and `!loading && !data && !error` are states the
 * boolean version can represent and no UI ever handles. Here they cannot exist.
 *
 * Pair with `<AsyncView>`, which requires a skeleton and an empty state and so
 * makes `docs/apps/ux.md`'s "every state is designed" rule structural instead of
 * something a reviewer has to notice was skipped.
 */
export type AppQueryState<T> =
  | { status: "loading"; data: null; error: null; refetching: false }
  | { status: "refetching"; data: T | null; error: null; refetching: true }
  | { status: "ready"; data: T; error: null; refetching: false }
  | { status: "error"; data: null; error: AppQueryError; refetching: false };

export interface AppQueryError {
  message: string;
  /** The platform's error code (`NOT_FOUND`, `FORBIDDEN`, …) when there was one. */
  code?: string;
  status?: number;
  /**
   * Set when the route's connector call failed: that connector's envelope,
   * which `AsyncView` renders as `ConnectorErrorState` — "Not connected", with
   * no Retry, when an administrator has to act; an error with Retry otherwise.
   */
  envelope?: ConnectorErrorEnvelope;
}

export interface AppQuery<T> {
  state: AppQueryState<T>;
  /** Re-run the request. Keeps the previous data visible while it runs. */
  refetch: () => void;
}

function toQueryError(err: unknown): AppQueryError {
  if (err instanceof AppClientError) {
    const body = err.body as { code?: string } | null;
    const envelope = connectorErrorOf(err);
    return {
      message: err.message,
      code: body?.code,
      status: err.status,
      ...(envelope ? { envelope } : {}),
    };
  }
  return { message: "Something went wrong." };
}

/**
 * `spec` is `"GET /items"` — the same string the typed client takes. `input` is
 * serialized into the dependency key, so changing a filter refetches without the
 * caller maintaining a dependency array (the thing widgets.md warns is easy to
 * forget).
 */
export function useAppQuery<T = unknown>(
  appSlug: string,
  spec: string,
  input?: Record<string, unknown>,
): AppQuery<T> {
  // The input is compared BY VALUE, not identity: a caller writing `{ limit }`
  // inline creates a new object every render, and an identity comparison would
  // refetch forever. This is the dependency-array footgun widgets.md warns
  // about, removed rather than documented.
  const inputKey = JSON.stringify(input ?? {});
  const [nonce, setNonce] = useState(0);
  const requestKey = `${appSlug}|${spec}|${inputKey}|${nonce}`;

  // Only the RESULT is state. Loading and refetching are derived from whether
  // the settled result belongs to the request currently in flight — writing them
  // with a setState at the top of the effect is the cascading-render pattern
  // React's lint rule flags, and it is unnecessary: the information is already
  // in the two keys.
  const [settled, setSettled] = useState<
    | { key: string; data: T; error: null }
    | { key: string; data: null; error: AppQueryError }
    | null
  >(null);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    const key = requestKey;

    createAppClient(appSlug)
      .call(spec, JSON.parse(inputKey))
      .then((data) => {
        // `active` alone is enough to ignore a superseded response: React runs
        // the previous effect's cleanup before the next effect, so a slow first
        // filter can never overwrite a fast second one.
        if (!active) return;
        setSettled({ key, data: data as T, error: null });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setSettled({ key, data: null, error: toQueryError(err) });
      });

    return () => {
      active = false;
    };
  }, [appSlug, spec, inputKey, requestKey]);

  const state: AppQueryState<T> = (() => {
    if (settled?.key === requestKey) {
      return settled.error
        ? { status: "error", data: null, error: settled.error, refetching: false }
        : { status: "ready", data: settled.data, error: null, refetching: false };
    }
    // A request is in flight. If we already have data from a previous one, keep
    // showing it rather than flashing an anonymous skeleton at someone who just
    // changed a filter.
    if (settled && settled.data !== null) {
      return {
        status: "refetching",
        data: settled.data,
        error: null,
        refetching: true,
      };
    }
    return { status: "loading", data: null, error: null, refetching: false };
  })();

  return { state, refetch };
}
