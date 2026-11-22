# Licensing

MixOS is licensed under the **Mozilla Public License 2.0** ([`LICENSE`](LICENSE)).

The short version: **the platform is copyleft, what you build on it is yours.**

## Why MPL, and not GPL

MPL-2.0's copyleft attaches to a **file**, not to a whole program. That maps
onto a boundary this codebase already enforces at build time — between the
platform in `src/`, and the apps, connectors and themes that extend it.

GPL was the obvious candidate for a platform built around a plugin ecosystem.
It was rejected for two reasons specific to this project:

1. **Copyleft triggers on distribution, and nobody redistributes a web app.**
   A company running MixOS on its own servers is not distributing it. GPL would
   have imposed the friction of copyleft while delivering almost none of its
   reciprocity.
2. **The coupling between the platform and its extensions is unusually
   tight.** Apps are imported directly into the build
   (`@apps/<slug>/api/.../route`), share the process, and share generated
   types. Under GPL that is a strong
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
| Reusing the documentation in `docs/` | Credit MixOS (CC BY 4.0). Its code samples carry no obligation (CC0). |

### Covered Software

Everything in this repository except what [Not Covered
Software](#not-covered-software) lists, including:

- `src/**` (excluding `src/generated/**`, which is build output)
- `scripts/**` and `eslint-rules/**`
- `supabase/**` — the platform schema and its migrations
- `public/**` — the service worker, and the icons, which are the MixOS logo
  (see [Trademark](#trademark))
- `deploy/**`, and the build and deployment files at the root: `Dockerfile`,
  `Dockerfile.dev`, `docker-compose.yml`, `render.yaml`, `railway.json`,
  `vercel.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`,
  `dangerfile.ts`, `package.json`, `tsconfig.json`
- `.githooks/**` and `.github/**`

A file that can hold a comment carries the MPL notice in its first lines. One
that can't, such as JSON or an image, is covered by this document and
[`LICENSE`](LICENSE) instead, as MPL Exhibit A allows: the notice may go "in a
location (such as a LICENSE file in a relevant directory) where a recipient
would be likely to look for such a notice." A file that carries a licence
notice of its own keeps that licence.

### Not Covered Software

- **`apps/**`, `connectors/**`, `themes/**`** — extensions. Yours.
- **The templates** — `apps/_template/`, `connectors/_template/`,
  `connectors/_template-oauth/`, `themes/_template/` — released under **CC0
  1.0** (public domain), each with its own `LICENSE`. A template exists to be
  copied, and MPL copyleft follows a copied file; leaving them Covered would
  have meant every scaffolded app inheriting obligations on its first commit.
- **`docs/**`** — the documentation, under CC BY 4.0. See below.

### Documentation

`docs/**` is licensed under [**CC BY 4.0**](https://creativecommons.org/licenses/by/4.0/)
([`docs/LICENSE.md`](docs/LICENSE.md)). You can copy, adapt and republish it,
commercially too, as long as you credit MixOS, link to the licence and say
whether you changed it.

Code samples in the docs are also released under **CC0 1.0**, for the same
reason as the templates: they exist to be copied into your own work, and a
credit line shouldn't have to follow them there.

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
Contributor directly, so no separate CLA is required — except in `docs/`, where
they are accepted under CC BY 4.0. Sign off your commits
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

## Fonts

The built-in themes, `mixos` and `mixos-dark`, ship three fonts under the
**SIL Open Font License 1.1**: Inter, Plus Jakarta Sans and JetBrains Mono. Each
font's licence sits beside its file in `themes/<theme>/assets/fonts/`
(`OFL-*.txt`), and is served beside it too. The OFL lets you use, bundle and
redistribute the fonts, commercially too, as long as the licence goes with
them and you don't sell the fonts on their own. A theme of your own that copies
one of these files should copy its `OFL-*.txt` with it.

*This document explains the licence; it is not legal advice, and the text of
[`LICENSE`](LICENSE) governs where the two differ.*
