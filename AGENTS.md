# AGENTS.md

Notes for people and coding agents working on this repo.

## What ships

- `skills/logisticshub/` is the published skill. It is **built and committed**, because `npx skills`, the Claude Code plugin and the claude.ai zip install straight from the git tree and never run a build. Never edit it by hand: change the sources in `packages/` and run `pnpm build:skill`.
- `packages/cli` is the npm package `logisticshub` (CLI and MCP server), built with `pnpm build:cli`.
- `docs/logisticshub.md` and `docs/logisticshub.ka.md` are the text of the skill page on https://tsirbiladze.com/skills/logisticshub. The site renders them as they are and draws the install box itself.

## Rules

- **The checker never guesses.** If a value cannot be read reliably, emit the existing "could not read" warning, never an error. A clean document set must give no findings.
- **The fixtures are the contract.** All 36 variants in `fixtures/` must give exactly their planted findings (`packages/fixtures/test`). One has an invoice over two pages, one a scanned CMR and one two documents in one PDF (`layout` in `fixtures/index.json`); one has a second invoice (`files`), and one a number the checker cannot read for certain, with one extraction issue and no finding (`expectedIssues`). Every other reference extraction is free of extraction issues. Run `pnpm fixtures` only when the generator changes, and afterwards restore from git every PDF whose printed text did not change: Chromium's PDFs differ byte for byte from run to run.
- **Node and Python stay identical.** `skills/logisticshub/scripts/check.py` must produce byte-identical reports to `check.mjs` (`packages/skill/test/python.test.ts`). Any rule change goes into `packages/skill/python/check.py` as well.
- **Keep the skill folder clean.** Use only the Agent Skills frontmatter fields, keep the description ≤ 200 characters and SKILL.md under 500 lines, and put no development files under `skills/` (`packages/skill/test/layout.test.ts`).
- **Keep the first read short.** An agent reads `references/extraction.md` in full before the first field, so it stays at or under 180 lines and 16,600 bytes (the same test). What is needed only after the check (issue codes, notes) goes into `references/issues.md` (`packages/core/src/issues.ts`), which is opened when an issue or a note appears.
- **One version.** `packages/skill`, `packages/cli`, `.claude-plugin/plugin.json` and the SKILL.md metadata carry the same version. Bump all four in a release and add a `CHANGELOG.md` entry.
- **Keep the page docs in sync.** When the skill's behaviour, rules or limits change, update both `docs/logisticshub*.md` files. They have no H1, use absolute links, contain no install commands and do not copy the SKILL.md steps.
- **The docs are tested.** `packages/skill/test/docs.test.ts` holds the README and the page docs to the code and to each other: one text for "Limits" in the README and the page doc of each language, the 13 "Not checked" items of `references/rules.md`, the report example, the variant count and what the variants cover, twin sections in English and Georgian, the notes table of `packages/cli/README.md` (the rows of `references/issues.md`), the changelog's first lines. State a version of Node.js or Python as tested only after running the suite on it. The same goes for a model: `packages/cli/README.md` names the version, the model and the demo sets of the last run against a real model, so in a release either repeat the run and update the sentence, or add "This version has not been run against a real model."
- **The marked invoice is a render.** `docs/marked-invoice.png` is page 1 of `invoice.marked.pdf` from `fixtures/en-led-lighting/line-arithmetic` at 150 dpi (`pdftoppm -r 150 -png`), rows 40 to 899, with a 1 px `#D0D0D0` border: 1242 × 862. The website cuts two crops out of it by pixel coordinates, so make it again the same way when the marker or the fixture changes, and keep the size.
- **Messages in four languages.** User-facing texts exist in ka/en/ru/tr (`packages/core/src/check/messages.ts`, `report/i18n.ts`). Georgian text is never capitalized or written in Mtavruli.
- **Georgian speaks to the reader as „შენ“.** Imperatives are in the informal singular (`გაასწორე`, `გაუშვი`, `შეადარე`), never `თქვენ` forms: this is the owner's house style. Russian and Turkish keep the formal form.
- **Synthetic data only.** No real client documents, names or numbers anywhere in the repo.

## Commands

```bash
pnpm install
pnpm verify        # typecheck + all tests
pnpm build:skill   # skills/logisticshub
pnpm build:cli     # packages/cli/dist
pnpm fixtures      # synthetic packs and PDFs (needs Chromium and poppler)
```

Node 24 runs the TypeScript sources directly (type stripping), so there is no compile step for development.

## Release

1. Bump the version in the four places above and add the changelog entry.
2. `pnpm build:skill && pnpm build:cli && pnpm verify`, then commit and tag `vX.Y.Z`.
3. Create a GitHub release with `logisticshub-skill.zip` (the `skills/logisticshub` folder at the zip's root). The release workflow builds it from the tag.
4. `npm publish` from `packages/cli` (`pnpm pack` first, so the workspace versions get rewritten).
