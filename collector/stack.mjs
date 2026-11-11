// #C859 slice 2 (stack mode, design 2): a stack is READ from git, never typed. For a repository whose stack switch is on, the stack is every
// open card of that repository whose head commit is an ancestor of (or is) one branch tip. This module is that reading and nothing else: it
// takes the heads and the tips and an isAncestor(older, newer) over git, and returns what each card shows. It writes nothing and decides no
// wake (the dispatch is the next slice). Same input, same answer: no clock, no random.
//
//   readStack({ heads, tips, isAncestor }) -> { tip, branch, members: [id], outside: [id] } | null
//     heads: { cardId: sha } the head commit of each open card of the repository that has one pushed (a card with nothing pushed is "next in
//            the stack" by queue order, and has no head to place);
//     tips:  [{ branch, sha, at }] the repository's branch tips other than main;
//     isAncestor(a, b): true when a is b or an ancestor of b.
// The stack tip is the branch tip that holds the most heads (the most cards under it); a tie goes to the newest tip, then to the branch
// name, so two readings of one repository never disagree. A card whose head is not under that tip is "outside the stack": it was not cut
// from the stack tip (design 3). With no head, or no tip, there is no stack.
export function readStack({ heads, tips, isAncestor }) {
  const ids = Object.keys(heads ?? {}).sort();
  if (!ids.length || !Array.isArray(tips) || !tips.length) return null;
  let best = null;
  for (const t of tips) {
    if (!t || typeof t.sha !== "string" || typeof t.branch !== "string") continue;
    const members = ids.filter((id) => isAncestor(heads[id], t.sha));
    if (!members.length) continue;
    const better = !best || members.length > best.members.length
      || (members.length === best.members.length && ((t.at ?? 0) > (best.at ?? 0) || ((t.at ?? 0) === (best.at ?? 0) && t.branch < best.branch)));
    if (better) best = { tip: t.sha, branch: t.branch, at: t.at ?? 0, members };
  }
  if (!best) return null;
  const inside = new Set(best.members);
  return { tip: best.tip, branch: best.branch, members: best.members, outside: ids.filter((id) => !inside.has(id)) };
}

// What each card's state carries for the page and the dispatch: { tip: <12 hex>, size } for a member, { outside: true } for a card not cut
// from the tip. A stack of one card is no stack: it carries nothing (the switch off is today's reading).
// The stack's branch rides along (design 3: the builder's wake names it, and an outsider is told which tip to cut from) when it is a plain name.
export const STACK_BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;
export function stackFields(stack) {
  if (!stack || stack.members.length < 2) return {};
  const out = {};
  const branch = STACK_BRANCH.test(stack.branch) && !stack.branch.startsWith("-") ? { branch: stack.branch } : {};
  for (const id of stack.members) out[id] = { tip: stack.tip.slice(0, 12), size: stack.members.length, ...branch };
  for (const id of stack.outside) out[id] = { outside: true, ...branch };
  return out;
}
