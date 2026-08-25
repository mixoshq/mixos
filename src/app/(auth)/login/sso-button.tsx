"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function SsoButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setPending(true);
        signIn("oidc", { callbackUrl: "/" });
      }}
      className="mt-8 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-gray-900 shadow-sm transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Redirecting…" : "Login with SSO"}
    </button>
  );
}
