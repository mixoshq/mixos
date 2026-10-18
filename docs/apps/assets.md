# Assets

## Overview

Apps can include CSS, images, fonts, and other static assets. There are two approaches depending on how the asset is used: co-located imports (bundled by the build) and CSS modules or Tailwind for styling. All assets must live inside your app folder.

> **There is no opt-out from the design system.** Every app page renders with the platform's Tailwind layer and design tokens. An app supplies its own CSS *on top of* that baseline — it cannot replace it. No manifest flag grants a blank slate: it would be an escape from the contrast, spacing, and state guarantees every other rule depends on, and those guarantees have no escape. The only rule an app can escape in `app.json` is `raw-response`, for a route that returns its own Response.

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
import icon from "../assets/icon.svg";

export default function MyAppPage() {
  return (
    <div>
      {/* An imported image is an object; its URL is .src */}
      <img src={logo.src} alt="Logo" width={120} height={40} />
      <img src={heroImg.src} alt="Hero" />

      {/* So is an SVG: it is an image, not a React component */}
      <img src={icon.src} alt="" className="h-6 w-6" />
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
[data-app="my-app"] .section-label {
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
      <h2 className="section-label">...</h2>
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

## Screenshots

Images for the app's **catalogue listing** — what someone looks at while deciding whether to install. These are the one category of app asset that is not co-located and imported, because nothing in the app renders them: the listing does, from a public URL.

Put the files in `screenshots/` (a sibling of `assets/`, not inside it) and declare them in `app.json`:

```json
"screenshots": [
  {
    "file": "screenshots/dashboard.png",
    "alt": "The main dashboard showing this quarter's pipeline",
    "caption": "Everything on one screen"
  },
  { "file": "screenshots/settings.png" }
]
```

`file` carries its `screenshots/` prefix, the same way a connector's icon is written `assets/icon.svg` — the manifest says where the file actually is rather than leaving the directory implied. `alt` and `caption` are optional; write `alt` anyway, because omitting it does not make the image decorative, it makes it unlabelled. The order you declare is the order the gallery renders, so lead with the view that answers "what is this?".

You never write `url`, `width` or `height`. The build measures the file and fills those in, which is what lets a gallery reserve the right box before the image loads.

### Why not just put one in the README

Because it would not work. The listing renderer resolves a relative image path against mixos.org rather than against your repo, so an `![](./screenshots/dashboard.png)` in `README.md` publishes as a dead link — and you never see it, because the same file renders correctly on GitHub. The manifest field is the supported route. See [Architecture](./architecture.md#what-the-renderer-does-to-it).

### What the build enforces

| Rule | Limit | Why |
| --- | --- | --- |
| Format | `.png`, `.jpg`, `.jpeg`, `.webp` | No SVG. A screenshot is a raster by definition, and an SVG is a script-bearing document rather than an image — these are served from an unauthenticated URL. |
| Count | 8 | A gallery nobody scrolls past item eight. |
| File size | 2 MB each | They live in the repo and go over the wire on a listing page. |
| Minimum width | 640px | Below that it is a thumbnail and ships visibly soft on a high-DPI display. |

Height and aspect ratio are deliberately unconstrained: a full page, a single widget and a modal are different shapes, and forcing one aspect would letterbox two of them. Any violation aborts the build with a message naming the file and the measured value.

### Where they end up

Declared files are copied to `/screenshots/apps/<slug>/<name>` and served **without authentication** — a listing is read by someone who has not installed the app and has no session, so a gallery behind the auth redirect is a gallery with no audience.

Only declared files are copied. A draft or a reject left sitting in `screenshots/` never reaches a public URL, which is the property that makes the directory safe to work in.

## Summary

| Asset type | Approach |
| --- | --- |
| Images, SVGs, media | Co-locate in `assets/` and import |
| Scoped CSS | CSS Modules (`.module.css`) |
| Utility CSS | Tailwind (available everywhere) |
| Fonts | `next/font` (Google or local) |
| Listing screenshots | Declare in `app.json` `screenshots`, files in `screenshots/` |
