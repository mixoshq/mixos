export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="p-8">
      {children}
      <p className="mt-12 text-center text-xs text-muted-foreground">
        Made in Detroit with 🫶🏽
      </p>
    </div>
  );
}
