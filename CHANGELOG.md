# Changelog

## [0.4.2](https://github.com/cellajs/cella-cli/compare/cli-0.4.1...cli-0.4.2) (2026-10-24)


### 🎉 New features

* **audit:** report the security fixes this machine's Node, pnpm and gh miss ([#56](https://github.com/cellajs/cella-cli/issues/56)) ([1a7b5cb](https://github.com/cellajs/cella-cli/commit/1a7b5cbff4887f34f41d8c02cb1ed6baa835f474))


### 🐞 Bug fixes

* **audit:** a package that two workspaces list under different dependency types gets updated ([#55](https://github.com/cellajs/cella-cli/issues/55)) ([235a585](https://github.com/cellajs/cella-cli/commit/235a5851c830e4aae2a09dc500e76096a1ce600e))

## [0.4.1](https://github.com/cellajs/cella-cli/compare/cli-0.4.0...cli-0.4.1) (2026-10-22)


### 🎉 New features

* analyze and sync write one review page with the diff of every file they list ([#51](https://github.com/cellajs/cella-cli/issues/51)) ([5ca9542](https://github.com/cellajs/cella-cli/commit/5ca954207c45f5dffb4ec8d5171caf8120e678c9))
* **audit:** runtime pins join the update table, and a run asks once and installs once ([#52](https://github.com/cellajs/cella-cli/issues/52)) ([3ffcf6e](https://github.com/cellajs/cella-cli/commit/3ffcf6e48dadefede299febfa74eeee21e7666ed))


### 🐞 Bug fixes

* **deps:** installs run pnpm 11.28.7, which fixes three high advisories in 11.8.0 ([#53](https://github.com/cellajs/cella-cli/issues/53)) ([b7eeaa0](https://github.com/cellajs/cella-cli/commit/b7eeaa0195e1da422e953443667398ef2512042a))

## [0.4.0](https://github.com/cellajs/cella-cli/compare/cli-0.3.3...cli-0.4.0) (2026-10-15)


### ⚠ BREAKING CHANGES

* sync loses --hard, --unpinned and --log; forks loses --hard and --log; analyze loses --log, --diff and --open-diff. The legacy root cella.config.ts path is no longer read, and fileLinkMode: 'local' fails config validation.
* **audit:** `--check-overrides` is removed (`--list` reports which overrides stay and which go), and the `pnpm audit --fix override` entry is gone from the update prompt.

### 🎉 New features

* **audit:** security overrides are rebuilt from a fresh audit on every run ([#45](https://github.com/cellajs/cella-cli/issues/45)) ([ac3041f](https://github.com/cellajs/cella-cli/commit/ac3041f333b6420782c02c815136d92facf892f5))
* **sync:** --unpinned returns, lifting every pin for one run, and analyze previews it ([#48](https://github.com/cellajs/cella-cli/issues/48)) ([08e1d04](https://github.com/cellajs/cella-cli/commit/08e1d0409152ab80a6450a54f70a52ac1b4463dd))


### 🐞 Bug fixes

* **audit:** outdated packages show up when pnpm warns about the Node version ([#49](https://github.com/cellajs/cella-cli/issues/49)) ([aeca882](https://github.com/cellajs/cella-cli/commit/aeca88268a9b26577aac131b8f086ee90d568e47))
* **sync:** the sync PR keeps its versioned title, scripts keep upstream's order, and pins that do nothing warn ([#50](https://github.com/cellajs/cella-cli/issues/50)) ([9176504](https://github.com/cellajs/cella-cli/commit/9176504d7d6a7d43f338b0f328d2e4229990a521))


### 🔧 Small improvements

* trim the CLI by 2,900 lines: dead analyze worktree, unused flags, one helper per git operation ([#47](https://github.com/cellajs/cella-cli/issues/47)) ([d1030d9](https://github.com/cellajs/cella-cli/commit/d1030d9e636c463dc640f7a6e86f7ec783b2ab42))

## [0.3.3](https://github.com/cellajs/cella-cli/compare/cli-0.3.2...cli-0.3.3) (2026-10-12)


### 🐞 Bug fixes

* **sync:** release tracking finds version tags without the v prefix ([#43](https://github.com/cellajs/cella-cli/issues/43)) ([3e38dd6](https://github.com/cellajs/cella-cli/commit/3e38dd601e52bce5677a1a7f456895faac914ffe))

## [0.3.2](https://github.com/cellajs/cella-cli/compare/cli-0.3.1...cli-0.3.2) (2026-10-08)


### 🎉 New features

* **stats:** count what a branch changed by kind of file with --since ([#42](https://github.com/cellajs/cella-cli/issues/42)) ([302bd9f](https://github.com/cellajs/cella-cli/commit/302bd9f02d7ba8bf691acac93198122cebb17353))
* **sync:** stop before the merge when upstream changed its sync config, add migrate --run ([#39](https://github.com/cellajs/cella-cli/issues/39)) ([03ad3eb](https://github.com/cellajs/cella-cli/commit/03ad3eb65bc268318743be11fb500a9260688624))


### 🔧 Small improvements

* code consistency pass against cella house style ([#41](https://github.com/cellajs/cella-cli/issues/41)) ([b673615](https://github.com/cellajs/cella-cli/commit/b67361555ad3dc06493dc1e764900e659e8f26d4))

## [0.3.1](https://github.com/cellajs/cella-cli/compare/cli-0.3.0...cli-0.3.1) (2026-10-02)


### 🎉 New features

* **sync:** sync from a worktree, pin the upstream ref with --ref, sync package type ([#37](https://github.com/cellajs/cella-cli/issues/37)) ([63870a3](https://github.com/cellajs/cella-cli/commit/63870a32ff387378ecd7f438c73fc725764b79ec))

## [0.3.0](https://github.com/cellajs/cella-cli/compare/cli-0.2.3...cli-0.3.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* **sync:** `cella sync --direct-merge` is no longer accepted. Merge the sync PR by hand.

### 🎉 New features

* **migrate:** read upstream migration notes in place and track open ones ([#34](https://github.com/cellajs/cella-cli/issues/34)) ([10c14e0](https://github.com/cellajs/cella-cli/commit/10c14e07910abfad94bf884bf6ddba88795c01b7))
* **sync:** stop when upstream needs a newer CLI ([#30](https://github.com/cellajs/cella-cli/issues/30)) ([7c22d35](https://github.com/cellajs/cella-cli/commit/7c22d35fbeb1da6c1289f25f720ff53b0e807ebd))


### 🔧 Small improvements

* **sync:** remove --direct-merge ([#31](https://github.com/cellajs/cella-cli/issues/31)) ([f1a990b](https://github.com/cellajs/cella-cli/commit/f1a990b65a190c0ccaf54c1f7805b6b996b458e6))

## [0.2.3](https://github.com/cellajs/cella-cli/compare/cli-0.2.2...cli-0.2.3) (2026-10-01)


### 🎉 New features

* **analyze:** report upstream override entries and ignored paths only upstream changed ([#27](https://github.com/cellajs/cella-cli/issues/27)) ([dde3e55](https://github.com/cellajs/cella-cli/commit/dde3e55b6479a830db7bd599579c03b3331bc0a6))


### 🐞 Bug fixes

* **stats:** clarify labels for code files and package breakdown ([#28](https://github.com/cellajs/cella-cli/issues/28)) ([261ccf4](https://github.com/cellajs/cella-cli/commit/261ccf4f96fcddca1766e70196a98c6ecb63d376))

## [0.2.2](https://github.com/cellajs/cella-cli/compare/cli-0.2.1...cli-0.2.2) (2026-09-29)


### 🎉 New features

* **packages:** merge package.json keys three-way against the merge-base ([#25](https://github.com/cellajs/cella-cli/issues/25)) ([8f890ad](https://github.com/cellajs/cella-cli/commit/8f890ad11cc8c96beca4400291fc26e7e82812a8))


### 🐞 Bug fixes

* handle unknown ([ad11d6c](https://github.com/cellajs/cella-cli/commit/ad11d6c10f73fc6075ba83391bf0461f8a7c5198))

## [0.2.1](https://github.com/cellajs/cella-cli/compare/cli-0.2.0...cli-0.2.1) (2026-09-23)


### 🎉 New features

* **analyze:** surface pinned files that are behind upstream ([#21](https://github.com/cellajs/cella-cli/issues/21)) ([411a788](https://github.com/cellajs/cella-cli/commit/411a788f695f701340a4a26e0f3248eeb90420c6))
* **packages:** sync package.json exports, add-only ([#22](https://github.com/cellajs/cella-cli/issues/22)) ([e59b8c5](https://github.com/cellajs/cella-cli/commit/e59b8c5eb87e8a5e1fc1f2106c464ddd870ea84d))
* require Node.js 26 ([#24](https://github.com/cellajs/cella-cli/issues/24)) ([8143536](https://github.com/cellajs/cella-cli/commit/81435365942fc4fe8661db48af7b9cf59f8803c3))

## [0.2.0](https://github.com/cellajs/cella-cli/compare/cli-0.1.1...cli-0.2.0) (2026-08-13)


### ⚠ BREAKING CHANGES

* **sync:** `cella sync` no longer pushes/opens the PR in the same run that commits the merge; rerun it on the committed branch to ship.

### 🎉 New features

* **sync:** commit and ship in separate runs, no flag needed ([#19](https://github.com/cellajs/cella-cli/issues/19)) ([42b2216](https://github.com/cellajs/cella-cli/commit/42b22168e53ff052471985e2319ad91442ec33af))

## [0.1.1](https://github.com/cellajs/cella-cli/compare/cli-0.1.0...cli-0.1.1) (2026-08-03)


### 🐞 Bug fixes

* **sync:** recognize legacy config path on the cella/ move + warn on masking pins ([#17](https://github.com/cellajs/cella-cli/issues/17)) ([7818c13](https://github.com/cellajs/cella-cli/commit/7818c13a7512a3c5274da5f7e1c5195163ab73e3))

## [0.1.0](https://github.com/cellajs/cella-cli/compare/cli-0.0.6...cli-0.1.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* **config:** forks must move cella.config.ts and cella.manifest.json into their cella/ folder; the CLI no longer looks at the repo root.

### 🎉 New features

* **config:** discover cella files under the cella/ folder ([#16](https://github.com/cellajs/cella-cli/issues/16)) ([872e177](https://github.com/cellajs/cella-cli/commit/872e1775e3b997d8fe31b48939eb9783d78eac5f))
* recognize defineBackendModule/defineFrontendModule in module territory scan ([#15](https://github.com/cellajs/cella-cli/issues/15)) ([2568f9e](https://github.com/cellajs/cella-cli/commit/2568f9eed5cb265e9f51c4170272705a77d87ec9))


### 🐞 Bug fixes

* **analyze:** clarify local and ahead status descriptions ([fecf3a0](https://github.com/cellajs/cella-cli/commit/fecf3a02fdb0f6201054b6ad26073d41246bdfad))
* **forks:** support running from a linked git worktree ([ef4138a](https://github.com/cellajs/cella-cli/commit/ef4138ac5650a2acd8f29d85a4e7613ab8daaa9a))
* stats without stories ([2f2a1cf](https://github.com/cellajs/cella-cli/commit/2f2a1cf95547b10e63e5a2b954aa8afa26b53c89))
* **sync:** recover shallow clones before resolving the merge-base ([10aec72](https://github.com/cellajs/cella-cli/commit/10aec724ec8e50353063e7c6bedddd2ed6360348))

## [0.0.6](https://github.com/cellajs/cella-cli/compare/cli-0.0.5...cli-0.0.6) (2026-07-09)


### 🎉 New features

* graft recorded sync point so merges ignore squash-stale base ([#10](https://github.com/cellajs/cella-cli/issues/10)) ([2196855](https://github.com/cellajs/cella-cli/commit/21968551392f031f5e46a8ba3c6a1ea3e7e03e5c))
* warn on unmerged sync PR and add --direct-merge ([#13](https://github.com/cellajs/cella-cli/issues/13)) ([9a7411c](https://github.com/cellajs/cella-cli/commit/9a7411c0f158c1afbe1d4a8ce26d0a5826a9f9f3))

## [0.0.5](https://github.com/cellajs/cella-cli/compare/cli-0.0.4...cli-0.0.5) (2026-07-07)


### 🎉 New features

* sort contributions by most recent fork change ([#8](https://github.com/cellajs/cella-cli/issues/8)) ([bfe7400](https://github.com/cellajs/cella-cli/commit/bfe74001bfea6b1c3e7b435dcf8ade43e4c3c137))

## [0.0.4](https://github.com/cellajs/cella-cli/compare/cli-0.0.3...cli-0.0.4) (2026-07-06)


### 🎉 New features

* bootstrap scaffold sync base from Cella-Base trailer with tree-similarity fallback ([#4](https://github.com/cellajs/cella-cli/issues/4)) ([fb492d1](https://github.com/cellajs/cella-cli/commit/fb492d11b6f8c0296cc66566e74643329771a945))
* versioned sync commit subject and upstream commit list in PR body ([#6](https://github.com/cellajs/cella-cli/issues/6)) ([db63de6](https://github.com/cellajs/cella-cli/commit/db63de62a6931cbe9a9124e24e3f93340aa5bdd9))

## [0.0.3](https://github.com/cellajs/cella-cli/compare/cli-0.0.2...cli-0.0.3) (2026-07-04)


### 🎉 New features

* diff in browser ([#2](https://github.com/cellajs/cella-cli/issues/2)) ([deb997c](https://github.com/cellajs/cella-cli/commit/deb997c2394a47752df11c8c9c0ada949bdabda7))

## [0.0.2](https://github.com/cellajs/cella-cli/compare/cli-0.0.1...cli-0.0.2) (2026-07-03)


### 🎉 New features

* extract cella cli package ([de0d648](https://github.com/cellajs/cella-cli/commit/de0d648242c0583e3148d8299bb01351ab1345f6))


### 🐞 Bug fixes

* prune orphaned worktree refs ([4a49cb6](https://github.com/cellajs/cella-cli/commit/4a49cb6b07912755090e58f441736d9884a33700))
* show managed files separately in analysis ([972c3db](https://github.com/cellajs/cella-cli/commit/972c3dbb19c30003697f7944ee270ffc063ced0f))


### 🔧 Small improvements

* keep fork sync branch internal ([cefd65e](https://github.com/cellajs/cella-cli/commit/cefd65e69931afad481ffba69a493499d9c4c701))
* keep sync branch prefix internal ([3a065c0](https://github.com/cellajs/cella-cli/commit/3a065c057f9b3fbc13ca3256a98c00936d3d438b))
* run fork syncs through normal flow ([9269f41](https://github.com/cellajs/cella-cli/commit/9269f4133e21a1f6bde1626690617371645fc770))

## 0.0.1

Initial standalone package extraction.
