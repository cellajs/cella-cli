# Changelog

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
