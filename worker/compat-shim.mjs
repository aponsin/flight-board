// The shim that lets the OLD page run on the Worker (#C723): it defines window.claude.use(name) ahead of the page's own script, so
// the page's data block (board.template.html "window.claude.use("db")", about line 2880) finds a db that reads GET /api/compat and
// writes POST /api/compat/write. The page code is unchanged. It is plain browser JavaScript kept as a string so the Worker can put
// it in the page under the response's nonce; tests/compat-shim.test.mjs runs this very text in a vm.
//   use("db")      collection(name).onSnapshot(next, err) -> unsubscribe;  doc(path).set | update | delete -> promise
//   use("mcp")     watchTool(server, tool, args, onEvent, {refetchInterval}) delivers the probe document the way the old state tool did
//   use(other)     resolves to null: comments, assets and downloads are absent, and the page already hides what needs them
// Reads: 2.5 s poll with If-None-Match, none while the tab is hidden, one at once when it shows again. A failed poll tells every
// open subscription's error handler once per failure streak (the page then says "connection lost"). Writes: a refused write
// rejects with "<rule>: <detail>", which the page shows as "Not saved".
export const COMPAT_SHIM = String.raw`(function () {
  var POLL_MS = 2500;
  var subs = [], watchers = [], etag = null, data = { collections: {}, probe: null }, seen = {}, probeSeen = "", loaded = false, failing = false, timer = null, busy = false;
  var nameOf = function (path) { return String(path).split("/")[0]; };
  var docsOf = function (name) {
    return (data.collections[name] || []).map(function (d) { var rest = {}; for (var k in d) if (k !== "id") rest[k] = d[k]; return { id: d.id, data: function () { return rest; } }; });
  };
  var deliver = function (s) { try { s.next({ docs: docsOf(s.name) }); } catch (e) { /* the page's handler failed: not ours */ } };
  var notify = function (force) {
    var changed = {};
    Object.keys(data.collections).forEach(function (n) { var j = JSON.stringify(data.collections[n]); if (force || seen[n] !== j) { seen[n] = j; changed[n] = true; } });
    subs.forEach(function (s) { if (changed[s.name] || (force && !data.collections[s.name])) deliver(s); });
    var pj = JSON.stringify(data.probe);
    if (data.probe && (force || pj !== probeSeen)) { probeSeen = pj; watchers.forEach(function (w) { try { w({ type: "data", result: { payload: data.probe } }); } catch (e) { /* ignore */ } }); }
  };
  var poll = function () {
    if (busy) return Promise.resolve();
    busy = true;
    return fetch("/api/compat", { headers: etag ? { "if-none-match": etag } : {}, credentials: "same-origin", cache: "no-store" }).then(function (r) {
      if (r.status === 304) { failing = false; return; }
      if (!r.ok) throw new Error("answered " + r.status);
      var tag = r.headers.get("etag");
      return r.json().then(function (j) { etag = tag; data = j; loaded = true; failing = false; notify(false); });
    }).catch(function (e) {
      if (!failing) { failing = true; subs.slice().forEach(function (s) { try { if (s.err) s.err(e); } catch (x) { /* ignore */ } }); }
    }).then(function () { busy = false; });
  };
  var schedule = function () {
    if (timer) return;
    timer = setInterval(function () { if (typeof document !== "undefined" && document.hidden) return; poll(); }, POLL_MS);
    if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
    poll();
  };
  var write = function (op, path, body) {
    return fetch("/api/compat/write", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ op: op, path: path, data: body }) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok && j.ok !== false) { etag = null; return poll(); }
        var why = j && j.refused ? j.refused.rule + ": " + j.refused.detail : "answered " + r.status;
        throw new Error(why);
      });
    });
  };
  var db = {
    collection: function (name) {
      return { onSnapshot: function (next, err) {
        var s = { name: name, next: next, err: err };
        subs.push(s); schedule();
        if (loaded) Promise.resolve().then(function () { deliver(s); });
        return function () { var i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
      } };
    },
    doc: function (path) {
      return {
        get: function () { var n = nameOf(path), id = String(path).split("/")[1]; return Promise.resolve(docsOf(n).filter(function (d) { return d.id === id; })[0] || { id: id, data: function () { return undefined; } }); },
        onSnapshot: function () { return function () {}; },
        set: function (x) { return write("set", path, x); },
        update: function (x) { return write("update", path, x); },
        delete: function () { return write("delete", path); }
      };
    }
  };
  var mcp = {
    watchTool: function (server, tool, args, onEvent) { watchers.push(onEvent); schedule(); if (loaded && data.probe) Promise.resolve().then(function () { onEvent({ type: "data", result: { payload: data.probe } }); }); return function () { var i = watchers.indexOf(onEvent); if (i >= 0) watchers.splice(i, 1); }; },
    callTool: function () { return Promise.reject(new Error("not available on the Worker")); }
  };
  window.claude = { use: function (name) { return Promise.resolve(name === "db" ? db : name === "mcp" ? mcp : null); } };
})();`;
