# Screenshots

Images for this app's catalogue listing. Drop them here and declare them in
`app.json`; the build verifies, measures and publishes each one.

Do **not** reference them from `README.md`. The listing renderer resolves a
relative image path against mixos.org rather than against your repo, so an
`![](./screenshots/dashboard.png)` in a README publishes as a dead link. This
directory plus the manifest field is the supported route.

## Declaring them

```json
"screenshots": [
  {
    "file": "screenshots/dashboard.png",
    "alt": "The app's main page showing three widgets side by side",
    "caption": "Everything on one screen"
  },
  { "file": "screenshots/settings.png" }
]
```

`file` carries its `screenshots/` prefix, the same way a connector's icon is
written `assets/icon.svg` — the manifest says where the file actually is.

`alt` and `caption` are both optional. Write `alt` anyway: it is what a screen
reader announces, and leaving it out does not make the image decorative, it
makes it unlabelled. `caption` is visible text under the image.

The order you list is the order the gallery renders. Lead with the one that
answers "what is this?" — usually the main page with real-looking data in it,
not an empty state and not a settings form.

You do not write `url`, `width` or `height`. The build measures the file and
fills those in.

## What the build enforces

| Rule | Limit |
| --- | --- |
| Format | `.png`, `.jpg`, `.jpeg`, `.webp` — **no SVG** |
| Count | 8 |
| File size | 2 MB each |
| Minimum width | 640px |

Height and aspect ratio are unconstrained — a full page and a single widget are
different shapes. Anything that fails aborts the build with a message naming
the file and the measured value.

SVG is excluded deliberately: a screenshot is a raster by definition, and an
SVG is a script-bearing document rather than an image. These files are served
from an unauthenticated URL.

## Where they end up

Declared files are copied to `/screenshots/apps/<slug>/<name>` and served
without authentication — a listing is read by someone who has not installed the
app and has no session. Only declared files are copied, so a draft or a reject
left in this directory stays local.

Delete this file once you have added real screenshots.
