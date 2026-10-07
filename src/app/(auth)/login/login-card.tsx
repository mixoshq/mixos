/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useActionState, useState } from "react";
import { cn } from "@/lib/utils";
import LoginLockup from "@/components/login-lockup";
import type { BrandLogo } from "@/lib/branding/types";
import CredentialsFields from "./credentials-fields";
import { signInWithCredentials, type CredentialsSignInState } from "./actions";

const INITIAL: CredentialsSignInState = { error: null, attempt: 0, email: "" };

/**
 * The sign-in card.
 *
 * ON SUBMIT, EVERYTHING BUT THE LOGO FADES. The frame and the fields go to
 * opacity 0 while the request is pending. On success the server redirects to
 * the dashboard, where the welcome tour (for a first sign-in) draws the same
 * logo at the same spot — so the fade here is the first beat of the tour, and
 * the logo is the one thing that never moves. On failure the fields fade back
 * in and the card shakes.
 *
 * THE SHAKE IS KEYED ON THE ATTEMPT, NOT THE ERROR. Two wrong passwords in a
 * row produce the same message; `attempt` is what makes the second one
 * shake too. It is adjusted during render (React's prop-derived-state
 * pattern) rather than in an effect, and cleared by the animation's own end.
 */
export default function LoginCard({
  logo,
  name,
}: {
  logo: BrandLogo | null;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(
    signInWithCredentials,
    INITIAL,
  );
  const [seenAttempt, setSeenAttempt] = useState(state.attempt);
  const [shaking, setShaking] = useState(false);
  if (state.attempt !== seenAttempt) {
    setSeenAttempt(state.attempt);
    if (state.error) setShaking(true);
  }

  const faded = pending ? "opacity-0" : "opacity-100";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-brand px-4">
      <div
        className={cn(
          "relative w-full max-w-sm p-8 text-center",
          shaking && "login-shake",
        )}
        onAnimationEnd={() => setShaking(false)}
      >
        <div
          aria-hidden
          className={cn(
            "absolute inset-0 rounded-lg border border-white/10 bg-white/5 shadow-lg backdrop-blur transition-opacity duration-300",
            faded,
          )}
        />
        <div className="relative">
          <LoginLockup logo={logo} name={name} />
          <form
            action={formAction}
            className={cn("mt-8 transition-opacity duration-300", faded)}
          >
            <CredentialsFields
              error={state.error}
              pending={pending}
              email={state.email}
            />
          </form>
        </div>
      </div>
    </div>
  );
}
