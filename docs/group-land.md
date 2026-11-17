# Landing a group: who merges, who signs, who lands (#C1130)

Written after G17 (11-16), the first group landed as one merged head. Release had no checkout of the repository and no right to merge, and asked who does. This is the answer, and the three traps that cost the night.

## The recipe
1. **The repository's builder merges.** The builder of the repository (Boardsmith for flight-board) makes `build/<group>-group`: a real merge of each signed card tip, in the stack order of the group, with `git merge --no-ff`, then one data-fragments fold commit (`node scripts/data-fragments.mjs --write`), then the full suite once on the head. Every conflict is resolved as a union and written down per merge (`git show --cc`), so a reviewer can read only the resolutions.
2. **Both reviewers sign EVERY commit** of `origin/main..<head>` with a note of its own, per role: Checker or Checker 2 writes `PASS ...` in `refs/notes/checker`, Security writes `SECURE ...` in `refs/notes/security` (use `node scripts/sign-note.mjs`, inside the checkout that holds the commit). The merge commits and the fold commit are signed too. The builder says which sha carries each note.
3. **Release lands that one head**, and nothing else. A card branch is not landed on its own once its group has a head.
4. **The builder cuts one pack from the new `main`** (`node scripts/make-pair.mjs <sha> <n> --out <the pair folder> --repo <checkout>`), after Release says it landed. Security reviews the pack; the owner runs it.

## The three traps
1. **A line note covers nothing here.** A role's `line from <base>` note on the tip covers `base..tip` only when the range holds no merge commit and at most 30 commits (`scripts/board-release.mjs` and `scripts/self-deploy-gate.mjs`: "groups are linear", `GROUP_MAX`). A group head is a merge of the cards, so every commit needs its own note.
2. **The release tool wants a note on every commit, from both roles.** A Quick card's commits need Security's `SECURE` too: the tool reads the notes of `origin/main..tip` for each role, and "no `SECURE` from Security" on a commit named in the range refuses the land, whatever the card's review level was.
3. **An early commit marked `SUPERSEDED`, `SUPERSEDED-BY-REBASE` or `WIP` blocks the land.** A first line that is not the role's word (`PASS`, `SECURE`) is a bad note, and it is covered only by that same role's valid line note, which trap 1 rules out. Once a merge brings such a commit into main's history (12 of them on G17), each must be signed again as `PASS` or `SECURE` naming the covering tip, or the builder squashes the card into one commit before its final READY, so no early commit is left to carry such a word. Reviewers: sign a card's last tip with the word, and re-sign its earlier commits by diff when a group is cut.

## Before the group is landed (Manager)
The pre-land check reads each note's first line, not only that a note exists: every commit of `origin/main..<head>` must have a `PASS` (Checker or Checker 2) and a `SECURE` (Security), by the verdict word. A note that exists and says `SUPERSEDED`, `WIP`, `FINDINGS` or `RISKS` is a blocker, and the check names the commit.
