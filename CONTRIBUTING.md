# Working on CADgang together

Each of us bends CADgang to how we work, and the good parts flow back to everyone. To keep that from turning into collisions:

1. **One main.** Branch from `cheewee2000/cadgang` main (or your fork's copy of it), and pull main at least daily. The longer a branch lives, the harder it lands.
2. **One feature per PR, small and soon.** A PR that bundles a dozen versions of work is hard to review, and the disagreements in it surface too late.
3. **Leave the version alone.** Only `npm run release` bumps it. A version bump in a PR is a merge conflict waiting to happen.
4. **Prefer a preference to a changed default.** If you want something to behave differently from how it does now, add a setting rather than changing it for everyone. If you really mean to change a default, put it under a **Changes defaults** heading in the PR so it gets a real decision.
5. **Respect "Decided".** CLAUDE.md lists the settled choices, and `test/decisions.test.js` pins them. Claude Code reads CLAUDE.md, so your session won't undo them by accident. To change one, ask first, then update both files in the same PR.
6. **Before opening a PR:** `npm test` and `npm run build` both pass.
7. **Releases** come from Che-Wei, with notes, so there's one update feed and one set of notes everyone sees.
