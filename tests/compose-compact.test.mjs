// The new-thread form keeps its compact look as he types (#C359, the owner's B in #T968, with previews per #T965):
// always one box, never the full form. Empty, it is one line: the text, then Attach and Send. With text or files the
// same box grows: attachments at its top as chips that wrap (an image a 44 px rounded thumbnail with a round dark × at
// its top-right; a document a chip with its type icon, red for PDF, its name cut past 240 px and "PDF · 48 KB" under
// it, its × a 28 px tap area), the text under them up to about 6 lines (#C357), and a bar at the bottom: the Enter
// hint on the left on a laptop, Attach and Send on the right. On a phone: a paperclip for Attach, the placeholder
// "Ask Manager anything", no Enter hint.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const b = loadNames(["ntChip", "ntFilesHtml", "ntAttachHtml", "ntPlaceholder", "fileKind"]);

test("one box: the chips, the text, then a bar with the hint, Attach and Send", () => {
  assert.ok(page.includes('<form class="newthread" id="newthread" data-reply="new"><label class="sr" for="nttext">Start a thread</label><div class="cbox"><div id="ntfiles"></div><textarea id="nttext" rows="1" placeholder="Ask Manager something, or share an idea"></textarea><div class="cbar"><div class="keys" data-keys></div><span class="cbtns btns"><span id="ntattach"></span><button type="submit" class="ok">Send</button></span></div></div><div class="msg" id="ntmsg" role="status"></div></form>'));
  assert.doesNotMatch(page, /\.newthread:not\(:focus-within\)/, "focus alone never opens it");
  assert.match(page, /\.newthread:not\(\.has\) \.cbox\{grid-template-columns:minmax\(0,1fr\) auto\}/, "empty: one line, the text then the buttons");
  assert.match(page, /\.newthread:not\(\.has\) :is\(#ntfiles,\.cbar \.keys\)\{display:none\}/);
});

test("a document's chip: its type, red for PDF; the name; type and size under it; a × with a 28 px tap area", () => {
  const pdf = b.ntChip({ name: "makaan-notes.pdf", type: "application/pdf", size: 48 * 1024 }, 1, null);
  assert.match(pdf, /^<span class="cdoc"><span class="ctype pdf" aria-hidden="true"><svg [^>]*>[\s\S]*?<\/svg><\/span><span class="cmeta"><span class="cname" title="makaan-notes.pdf">makaan-notes.pdf<\/span><small>PDF · 48 KB<\/small><\/span><button type="button" class="fx" data-unattach="new" data-n="1" aria-label="Remove makaan-notes.pdf">×<\/button><\/span>$/, "a document icon, red for PDF");
  assert.match(b.ntChip({ name: "log.txt", type: "text/plain", size: 900 }, 0, null), /<span class="ctype" aria-hidden="true"><svg[\s\S]*<small>TXT · 1 KB<\/small>/, "other types: their type under the name");
  assert.match(b.ntChip({ name: "<b>.md", type: "text/markdown", size: 10 }, 0, null), /&lt;b&gt;\.md/, "escaped");
  assert.match(page, /\.cdoc \.cname\{[^}]*max-width:240px;[^}]*text-overflow:ellipsis/);
  assert.match(page, /\.ctype\.pdf\{[^}]*color:var\(--bad\)/);
  assert.match(page, /\.cdoc \.fx\{[^}]*min-width:28px;min-height:28px/);
});

test("an image's chip: a 44 px rounded thumbnail that opens the viewer, a round dark × at its top-right", () => {
  const img = b.ntChip({ name: "pot.jpg", type: "image/jpeg", size: 3e5 }, 0, "blob:x/1");
  assert.equal(img, '<span class="cimg"><button type="button" class="thumb fthumb" data-full="blob:x/1" data-cap="pot.jpg"><img src="blob:x/1" alt="Preview of pot.jpg"></button><button type="button" class="cx" data-unattach="new" data-n="0" aria-label="Remove pot.jpg">×</button></span>');
  assert.match(page, /\.cimg \.cx\{[^}]*position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;[^}]*\}/);
  assert.match(page, /\.cimg \.fthumb\{[^}]*border:1px solid var\(--line\);border-radius:8px/);
  assert.match(b.ntFilesHtml([]), /^$/, "no files: nothing");
  assert.match(b.ntFilesHtml([{ name: "a.pdf", type: "application/pdf", size: 1 }]), /^<div class="files cchips">/, "the viewer's scope (.files) and the chips' row");
});

test("Attach: only where files can be stored; a paperclip with its word, the word hidden on a phone", () => {
  assert.equal(b.ntAttachHtml(false), "");
  const a = b.ntAttachHtml(true);
  assert.match(a, /^<button type="button" class="attach" data-attach="new" aria-label="Attach files"><svg class="clip"[^>]*aria-hidden="true">[\s\S]*<\/svg><span class="atxt">Attach<\/span><\/button><input type="file" id="file-new" data-files="new" multiple hidden accept="[^"]+">$/);
  assert.match(page, /@media \(max-width:600px\)\{\.cbar \.keys,\.cbtns \.atxt\{display:none\}\.cbtns \.clip\{display:inline-block\}\}/);
});

test("the placeholder: shorter on a phone", () => {
  assert.equal(b.ntPlaceholder(true), "Ask Manager anything");
  assert.equal(b.ntPlaceholder(false), "Ask Manager something, or share an idea");
  assert.equal(b.fileKind({ name: "x.PDF", type: "" }), "PDF");
  assert.equal(b.fileKind({ name: "notes", type: "text/plain" }), "TXT");
});
