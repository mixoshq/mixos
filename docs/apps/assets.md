# Assets

## Overview

Apps can include CSS, images, fonts, and other static assets. There are two approaches depending on how the asset is used: co-located imports (bundled by the build) and CSS modules or Tailwind for styling. All assets must live inside your app folder.

> **There is no opt-out from the design system.** Every app page renders with the platform's Tailwind layer and design tokens. An app supplies its own CSS *on top of* that baseline — it cannot replace it. The `disableOsStyles` manifest flag that used to grant a blank slate has been removed: it was an escape from the contrast, spacing, and state guarantees every other rule depends on. If your app genuinely needs to break one of those, declare a scoped escape in `app.json` rather than discarding the whole system.

## Co-located Imports (Recommended)

Place assets directly in your app directory and import them in your components. The bundler handles optimization, hashing, and cache-busting automatically. This is the recommended approach for images, SVGs, and other media that belong to your app.

```
apps/my-app/
  assets/
    logo.png
    hero-banner.jpg
    icon.svg
  pages/
    Main.tsx
```

```tsx
// apps/my-app/pages/Main.tsx
import logo from "../assets/logo.png";
import heroImg from "../assets/hero-banner.jpg";
import Icon from "../assets/icon.svg";

export default function MyAppPage() {
  return (
    <div>
      {/* Next.js Image component (optimized) */}
      <Image src={logo} alt="Logo" width={120} height={40} />

      {/* Standard img tag also works */}
      <img src={heroImg.src} alt="Hero" />

      {/* SVGs can be imported as React components */}
      <Icon className="h-6 w-6" />
    </div>
  );
}
```

Co-located assets are bundled and served with hashed filenames (e.g. `logo.a1b2c3.png`), so browsers cache them efficiently and you never need to worry about stale files.

## CSS & Styling

The platform uses Tailwind CSS, and all Tailwind utility classes are available in your app components out of the box. For app-specific styles beyond Tailwind, you have two options:

### CSS Modules (scoped styles)

CSS Modules scope class names to your component automatically, so there is no risk of style collisions with other apps or the platform.

```
apps/my-app/
  styles/
    dashboard.module.css
  pages/
    Main.tsx
```

```css
/* apps/my-app/styles/dashboard.module.css */
.container {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 1.5rem;
}

.sidebar {
  background: var(--color-card);
  border-radius: 0.75rem;
  padding: 1rem;
}

.chart {
  height: 300px;
  animation: fadeIn 0.3s ease-in;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

```tsx
// apps/my-app/pages/Main.tsx
import styles from "../styles/dashboard.module.css";

export default function MyAppPage() {
  return (
    <div className={styles.container}>
      <aside className={styles.sidebar}>...</aside>
      <main className={styles.chart}>...</main>
    </div>
  );
}
```

### Global CSS (use sparingly)

You can import a plain `.css` file (not `.module.css`) from a client component. These styles are global and can affect other apps, so always scope your selectors with a unique wrapper class or data attribute.

```css
/* apps/my-app/styles/global.css */
[data-app="my-app"] .custom-table th {
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

```tsx
// apps/my-app/pages/Main.tsx
"use client";
import "../styles/global.css";

export default function MyAppPage() {
  return (
    <div data-app="my-app">
      <table className="custom-table">...</table>
    </div>
  );
}
```

## Fonts

For custom fonts, use `next/font` for automatic optimization and self-hosting. This prevents layout shift and avoids external network requests.

```tsx
// apps/my-app/pages/Main.tsx
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });

export default function MyAppPage() {
  return (
    <div className={inter.className}>
      <p>This text uses the Inter font.</p>
    </div>
  );
}
```

For local font files, place them in your app's `assets/` directory and use `next/font/local`:

```tsx
import localFont from "next/font/local";

const myFont = localFont({
  src: "../assets/my-font.woff2",
  display: "swap",
});
```

## Summary

| Asset type | Approach |
| --- | --- |
| Images, SVGs, media | Co-locate in `assets/` and import |
| Scoped CSS | CSS Modules (`.module.css`) |
| Utility CSS | Tailwind (available everywhere) |
| Fonts | `next/font` (Google or local) |
