/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public route-group layout. Renders for both `visibility: "public"` and
// `visibility: "password"` pages. Deliberately bare: no `HeaderShell`, no
// `AuthProvider`, no `PreferencesProvider`. Once a password-protected page
// is unlocked, the rendered output is indistinguishable from a fully public
// one — both modes share this same minimal shell.
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-background">{children}</div>;
}
