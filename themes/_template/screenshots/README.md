# Screenshots

Images for this theme's catalogue listing. Drop them here and declare them in
`theme.json`; the build verifies, measures and publishes each one.

## Not the same thing as `assets.preview`

Both survive, because they answer different questions.

`assets.preview` is the **admin picker** thumbnail, shown beside a live swatch
row and a type specimen rendered from this theme's own resolved tokens. That
context is why the picker needs so little of it — colour and type are already
on screen, and more honestly than a screenshot could show them.

`screenshots` is the **listing gallery**, seen by someone who has not installed
the theme. None of those swatches exist for them. A picture is all there is, so
this is where a theme shows the thing its tokens cannot: how the menu bar sits
on `--brand`, what a table looks like at density, what the sign-in page does.

## Declaring them

```json
"screenshots": [
  {
    "file": "screenshots/dashboard.png",
    "alt": "Dashboard with the menu bar in the theme's brand colour",
    "caption": "The dashboard"
  },
  { "file": "screenshots/sign-in.png" }
]
```

`alt` and `caption` are optional; write `alt` anyway, since leaving it out makes
the image unlabelled rather than decorative. You do not write `url`, `width` or
`height` — the build measures the file.

Worth including, since these are the surfaces an author is asked to review
before merging anyway: a page with a table on it, a form, and **the sign-in page
signed out**, which is the one surface theme authors forget and the one every
user sees first.

## What the build enforces

| Rule | Limit |
| --- | --- |
| Format | `.png`, `.jpg`, `.jpeg`, `.webp` — **no SVG** |
| Count | 8 |
| File size | 2 MB each |
| Minimum width | 640px |

Anything that fails aborts the build with a message naming the file and the
measured value.

## Where they end up

This directory is **not** `assets/`. A theme's `assets/` is copied wholesale to
`/themes/<slug>/`; screenshots are copied, declared-files-only, to
`/screenshots/themes/<slug>/<name>`. Keeping them apart is what stops a
screenshot having two public URLs.

Both are served without authentication, for the same reason: a listing is read
before anything is installed.

Delete this file once you have added real screenshots.
