# Licensing

MixOS is licensed under the **Mozilla Public License 2.0** ([`LICENSE`](LICENSE)).

The short version: **the platform is copyleft, what you build on it is yours.**

## Why MPL, and not GPL

MPL-2.0's copyleft attaches to a **file**, not to a whole program. That maps
onto a boundary this codebase already enforces at build time — between the
platform in `src/`, and the apps, connectors and themes that extend it.

GPL was the obvious candidate, given how closely MixOS resembles WordPress
structurally. It was rejected for two reasons specific to this project:

1. **Copyleft triggers on distribution, and nobody redistributes a web app.**
   A company running MixOS on its own servers is not distributing it. GPL would
   have imposed the friction of copyleft while delivering almost none of its
   reciprocity.
2. **The plugin coupling here is far tighter than WordPress's.** Apps are
   imported directly into the build (`@apps/<slug>/api/.../route`), share the
   process, and share generated types. Under GPL that is a strong
   derivative-work argument — which would have meant a company's internal
   business logic inheriting the licence. AGPL would have been worse still:
   §13 obliges offering source to network users, and MixOS deliberately serves
   public app surfaces at `/api/p/<slug>`.

MPL avoids both by saying where the line is in the licence text, rather than
leaving it to interpretation.

## What that means in practice

| You are… | Obligation |
|---|---|
| Running MixOS, modified or not | None. Running is not distributing. |
| Writing an app, connector or theme | **None.** Licence it however you like, including proprietary. |
| Changing a Covered file (see below) **and distributing it** | Publish those files' Source Code Form under MPL-2.0. |
| Copying a `src/` file into your own tree and editing it | It stays Covered Software. Publish it if you distribute. |
| Shipping a built bundle that mixes platform and app code | Fine — MPL-2.0 §3.2 permits distributing Executable Form under other terms, provided the Covered Software's source stays available under MPL. |

### Covered Software

Every file carrying the MPL header, which is everything under:

- `src/**` (excluding `src/generated/**`, which is build output)
- `scripts/**`
- `eslint-rules/**`
- the root build configuration: `next.config.ts`, `postcss.config.mjs`,
  `eslint.config.mjs`, `dangerfile.ts`

### Not Covered Software

- **`apps/**`, `connectors/**`, `themes/**`** — extensions. Yours.
- **The templates** — `apps/_template/`, `connectors/_template/`,
  `connectors/_template-oauth/`, `themes/_template/` — released under **CC0
  1.0** (public domain), each with its own `LICENSE`. A template exists to be
  copied, and MPL copyleft follows a copied file; leaving them Covered would
  have meant every scaffolded app inheriting obligations on its first commit.

### Importing platform code does not make your file Covered

Your app importing `defineRoute` from `@/lib/apps/route`, or `Button` from
`@/components/ui/button`, creates a **Larger Work** under MPL-2.0 §3.3. Your
own files are not Covered Software, and you may licence them as you wish. This
is the case GPL would have treated very differently, and it is the main reason
MPL was chosen.

## Secondary Licenses

This project does **not** carry the Exhibit B "Incompatible With Secondary
Licenses" notice. MixOS may therefore be combined with GPL, LGPL or AGPL code,
and that combination distributed under those licences.

The consequence is worth stating plainly: a third party can fold MixOS into an
AGPL work downstream. That affects their distribution only — this repository
stays MPL-2.0, and so does anything you take from it. The compatibility was
judged more valuable than the restriction.

## Trademark

The MixOS name, wordmark and logo are **not** licensed by the MPL. A software
licence grants copyright and patent rights, never trademark rights. See
[`TRADEMARK.md`](TRADEMARK.md) for what forks, extensions and hosting services
can and can't be called.

## Contributing

Contributions are accepted under MPL-2.0 — MPL §2 grants the licence from each
Contributor directly, so no separate CLA is required. Sign off your commits
(`git commit -s`) to certify the [Developer Certificate of
Origin](https://developercertificate.org/). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the details, including the notice
every new platform file must carry.

## Dependencies

MixOS's dependency tree is predominantly MIT, ISC and BSD, with Apache-2.0 and
a handful of MPL-2.0 packages (`lightningcss`, `web-push`, `axe-core`) — all
compatible with MPL-2.0. One transitive dependency,
`@img/sharp-libvips-*` (via Next.js image optimisation), is **LGPL-3.0-or-later**;
that carries obligations only if you distribute it as a linked binary rather
than running it in a container.

*This document explains the licence; it is not legal advice, and the text of
[`LICENSE`](LICENSE) governs where the two differ.*
