# Translations

`pnpm cella i18n` reads `shared/locales/<language>/<file>.json` the way the app loads them: `namespaces.json` names the
namespaces that merge several files (`c` is `common.json` with `app.json` over it), and every other file is a namespace
of its own. English holds every key, and each other language is measured against it. What each command reports is in
the template's [Checks and renames](https://github.com/cellajs/cella/blob/main/shared/locales/README.md#checks-and-renames).

`pnpm cella i18n` exits 1 on a key English lacks or a mismatch. A missing translation falls back to English and only
counts.

## Keys built from a value

A key built from a value whose type is a union of literals, such as ``t(`c:${role}`)``, counts as a use of each key it
can build. A template whose values are open, such as an index, is reported by its pattern (`about:why.title_*`) as
unverified, and the keys it may build are never listed as unused.

## Renames

`pnpm cella i18n rename <ns:old> <ns:new>` renames a key and its plural forms in every language and every `'ns:old'`
literal in the code, then sorts the changed locale files with the app's own Biome. A key moves to another namespace too,
unless that namespace merges several files.

A rename lists what no literal rewrite reaches: the templates that may build the old key, and every key passed to `t()`
without its namespace.

`pnpm cella i18n unused` reads this app and the `forks` of `cella.config.ts` that exist on this machine. A template key
that only an app uses stays.
