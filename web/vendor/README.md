# Vendored Lit core

`lit-core.min.js` is a single-file, minified ESM bundle of Lit's core
(`@lit/reactive-element` + `lit-html` + `LitElement`, exporting `LitElement`,
`html`, `css`, `nothing`). The card imports it with a relative path so the Home
Assistant host works offline. Do not add `lit` to `package.json` dependencies —
this file is the source of truth.

- Pinned Lit version: **3.3.3** (`lit@3.3.3`)
  - `lit-element` 4.2.2, `lit-html` 3.3.3, `@lit/reactive-element` 2.1.2
- SHA-256: `b9923fc73cc50f0810aaf028cf498a8c07a69e3487be04717dd52f406de95b07`
- Vendored: 2026-09-11

## How it was produced (reproducible)

Lit 3.x no longer ships the pre-built `lit-core.min.js` inside the npm package
(it existed in Lit 2.x). To reproduce the same single-file core bundle:

```sh
mkdir /tmp/lit-vendor && cd /tmp/lit-vendor
npm install lit@3.3.3 --no-save
printf "export * from 'lit-element/lit-element.js';\n" > core-entry.js
npx esbuild@0.24 core-entry.js --bundle --format=esm --minify --outfile=lit-core.min.js
```

`lit-element/lit-element.js` re-exports all of `@lit/reactive-element` and
`lit-html`, so the bundle is the full Lit core — the same surface the old
`lit-core.min.js` provided. esbuild is a one-off fetch/vendoring tool here, not
a build-step or runtime dependency.

Verify the vendored file matches the pin:

```sh
shasum -a 256 web/vendor/lit-core.min.js
```
