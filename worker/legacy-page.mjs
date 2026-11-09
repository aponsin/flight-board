// The old board page, served by the Worker (#C723 A1, parity plan section 1). page/board.template.html is built by
// scripts/build-legacy.mjs with the team's config into a generated module (never committed); this file turns that built page
// into the document the Worker serves, changing as little as possible:
//   - the two Google Fonts tags go (fonts come from the Worker itself: font-src 'self');
//   - the lightbox's five inline onclick attributes become listeners by id, in one small script of ours (no inline handlers);
//   - every <script> and <style> element carries this response's nonce, and the CSP names only that nonce.
// Nothing here reads board data. Board text reaches the page only through the compatibility view and is drawn by the page's own
// render code (see tests/legacy-page.test.mjs, which feeds hostile text through it).
// 18 random bytes, base64 with the three odd characters swapped for letters (a nonce is only compared as text).
export const newNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, "x");

// The inline handlers of the old page, by element id: the page's own global functions stay the ones that run.
export const INLINE_HANDLERS = { "lb-prev": "stepShot(-1)", "lb-next": "stepShot(1)", "lb-out": "zoomBy(1/1.5)", "lb-in": "zoomBy(1.5)", "lb-close": "closeShot()" };
const CALLS = { "stepShot(-1)": "stepShot(-1)", "stepShot(1)": "stepShot(1)", "zoomBy(1/1.5)": "zoomBy(1/1.5)", "zoomBy(1.5)": "zoomBy(1.5)", "closeShot()": "closeShot()" };

export function csp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src-elem 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'", // the page sets widths and colours with style attributes; no script runs from one
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// The document for one response. `extraScript` (the compatibility shim, A2) is inserted before the page's own script so that
// window.claude exists when the page asks for it.
export function legacyDocument(html, nonce, extraScript = "") {
  if (typeof html !== "string" || !html.includes("<script>")) throw new Error("the built old page is missing");
  let out = html.replace(/<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g, "");
  out = out.replace(/ onclick="([^"]*)"/g, (m, call) => (Object.values(CALLS).includes(call) ? "" : m));
  if (/ on[a-z]+="/.test(out)) throw new Error("the old page has an inline handler this server does not know");
  out = out.replace(/<style>/g, `<style nonce="${nonce}">`);
  const wire = Object.entries(INLINE_HANDLERS).map(([id, call]) => `{const b=document.getElementById(${JSON.stringify(id)});if(b)b.addEventListener("click",()=>{${call}})}`).join("");
  const inject = (extraScript ? `<script nonce="${nonce}">${extraScript}</script>` : "");
  out = out.replace(/<script>/, () => `${inject}<script nonce="${nonce}">`);
  const last = out.lastIndexOf("</script>");
  out = `${out.slice(0, last + 9)}<script nonce="${nonce}">${wire}</script>${out.slice(last + 9)}`;
  return out;
}

export function legacyResponse(html, extraScript = "") {
  const nonce = newNonce();
  return new Response(legacyDocument(html, nonce, extraScript), { status: 200, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": csp(nonce),
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  } });
}
