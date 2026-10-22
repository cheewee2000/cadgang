# CADgang

A macOS viewer + markup app for CAD files (Swift shell in `mac/`, node server in `src/server/`, three.js page in `web/view.js`). Several people use it and send changes back. Read CONTRIBUTING.md.

## Working rules
- **Don't bump the version.** `npm run release` bumps it and commits. Branches and PRs leave `package.json`'s version alone.
- **Don't change a default someone else chose. Add a preference.** If a behaviour suits you but not the others, put it behind a setting (the footer's Trackpad / Mouse selector is the model: `localStorage` `cadgang-view`, followed across tabs). If a PR does change a default, say so under a **Changes defaults** heading.
- **Everything under "Decided" stays as written** unless the people involved agree. `test/decisions.test.js` pins these choices. If a test there fails, a change undid a decision. Don't edit the test to make it pass.
- `npm test` passes and `npm run build` (which runs `node --check` on every JS file) succeeds before a PR.
- Use the CW&T design system: Space Mono 400, black text, no border-radius.

## Decided
- **Scrolling:** a footer selector, **Trackpad** (default) or **Mouse**. Trackpad: two fingers turn the model and ⇧ pans. Mouse: two fingers pan and ⇧ turns. Pinch zooms in both, and so does a mouse-wheel notch.
- **Dragging a part, explode mode:** in Trackpad mode a plain drag slides the part along its explode axis and ⌥-drag places it freely. Mouse mode is the other way round.
- **Hotkeys:** B Bezier (the Figma-style pen), P pencil, A arrow, N note, ⇧T text, ⇧I image, R erase. J new joint, E toggles joint/explode mode, V explode direction, Q move triad, F fit, ← → nudge the explode (hold to scrub). Esc cancels the current tool. Edges has no key, and neither does Flip.
- **Names:** the Figma-style pen is labelled **BEZIER**.
- **Buttons:** a button that is on is drawn inverted. In the header, Open / Save / New sit at the left and the right-hand group stays right-justified.
- **Bodies panel:** the grip on the column's edge sets the width, and that width beats the name-fit minimum. Material and finish are right-justified. The panel stops above the bottom-left buttons.
- **Releases** are cut by Che-Wei only, always with user-facing notes (`npm run release -- "<html notes>"`). Sparkle shows the notes.
