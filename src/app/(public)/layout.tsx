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
  return <div className="min-h-screen bg-white">{children}</div>;
}
