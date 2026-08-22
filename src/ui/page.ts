export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>recall</title>
<style>
:root{color-scheme:light dark;
  --bg:#f6f7f9;--panel:#ffffff;--ink:#1c1f24;--muted:#6b7280;--line:#e3e6ea;--accent:#3b6fd6;--accent-ink:#fff;
  --ok:#1f9d55;--bad:#d04848;--chip:#eef1f5;--mono:ui-monospace,SFMono-Regular,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#121417;--panel:#1b1e23;--ink:#e6e8eb;--muted:#9aa3ad;--line:#2a2f36;--accent:#7aa2ff;--accent-ink:#0f1320;--ok:#4cc27a;--bad:#ef6b6b;--chip:#252a31}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,Segoe UI,sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;gap:.5rem;align-items:center;padding:.6rem 1rem;background:var(--panel);border-bottom:1px solid var(--line)}
header h1{font-size:15px;margin:0 .75rem 0 0;white-space:nowrap}
input,select,button{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.35rem .55rem}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{cursor:pointer}button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
button.icon{padding:.2rem .45rem;line-height:1}button.on{border-color:var(--accent);color:var(--accent)}
#q{flex:1;min-width:10rem}
.layout{display:grid;grid-template-columns:240px 1fr;min-height:calc(100vh - 50px)}
@media(max-width:760px){.layout{grid-template-columns:1fr}aside{display:none}}
aside{border-right:1px solid var(--line);padding:.75rem;background:var(--panel)}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:.75rem 0 .35rem}
aside .p{display:flex;justify-content:space-between;padding:.25rem .4rem;border-radius:5px;cursor:pointer}
aside .p:hover{background:var(--chip)}aside .p.sel{background:var(--accent);color:var(--accent-ink)}
aside .p span:last-child{opacity:.7;font-variant-numeric:tabular-nums}
.queue{font-size:12px;color:var(--muted)}.queue b{color:var(--ink)}.queue .err{color:var(--bad);margin-top:.3rem;word-break:break-word}
main{padding:.75rem 1rem;max-width:980px}
.tabs{display:flex;gap:.25rem;margin-bottom:.6rem}.tabs button{border-radius:6px 6px 0 0}.tabs button.on{background:var(--panel);border-bottom-color:var(--panel)}
.meta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin:.25rem 0 .5rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;margin-bottom:.5rem}
.card.arch{opacity:.6}
.top{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.badge{font-size:11px;padding:.05rem .45rem;border-radius:999px;background:var(--chip);color:var(--muted);text-transform:lowercase}
.badge.bugfix{color:var(--bad)}.badge.decision{color:var(--accent)}.badge.feature{color:var(--ok)}
.title{font-weight:600;flex:1}.date{color:var(--muted);font-size:12px;white-space:nowrap}
.conf{width:56px;height:5px;background:var(--chip);border-radius:3px;overflow:hidden;display:inline-block}
.conf i{display:block;height:100%;background:var(--accent)}
.narr{margin:.35rem 0;white-space:pre-wrap}
.facts{margin:.2rem 0 .2rem 1rem;padding:0;color:var(--ink)}.facts li{margin:.05rem 0}
.files{font:12px var(--mono);color:var(--muted);word-break:break-all}
.actions{display:flex;gap:.3rem;margin-left:auto}
.row{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin-top:.4rem;font-size:12px;color:var(--muted)}
.pager{display:flex;gap:.5rem;justify-content:center;align-items:center;margin:1rem 0}
.empty{color:var(--muted);padding:2rem;text-align:center}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem .8rem;margin:.3rem 0}dt{color:var(--muted)}dd{margin:0;white-space:pre-wrap}
.md{white-space:pre-wrap}
.edit input,.edit textarea{width:100%;margin:.25rem 0;font:inherit}.edit textarea{min-height:5rem;resize:vertical}.edit .facts-in{font:13px var(--mono)}
.ctx .q{font:12px var(--mono);color:var(--muted);word-break:break-word}.ctx ol{margin:.3rem 0 0 1.2rem;padding:0}.ctx li{margin:.1rem 0}.ctx .sc{color:var(--muted);font-size:11px;margin-left:.4rem}
</style></head><body>
<header><h1>recall</h1>
<input id="q" placeholder="search memory (FTS + vector)  —  press /" autocomplete="off">
<select id="type"><option value="">all types</option></select>
<button id="arch" class="icon" title="include archived">archived</button>
<button id="go" class="primary">search</button>
</header>
<div class="layout"><aside>
<h2>projects</h2><div id="projects"></div>
<h2>queue</h2><div id="queue" class="queue"></div>
</aside><main>
<div class="tabs"><button data-tab="observations" class="on">observations</button><button data-tab="summaries">sessions</button><button data-tab="digests">digests</button><button data-tab="context">injected</button></div>
<div class="meta"><span id="count"></span><span id="hint"></span></div>
<div id="list"></div>
<div class="pager" id="pager"></div>
</main></div>
<script>
(() => {
const S = { project: "", q: "", type: "", archived: false, page: 1, tab: "observations", names: {}, cache: {} };
const NL = String.fromCharCode(10);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rel = (ms) => { const d = (Date.now() - ms) / 1000; if (d < 60) return "just now"; if (d < 3600) return Math.floor(d/60) + "m ago"; if (d < 86400) return Math.floor(d/3600) + "h ago"; if (d < 86400*30) return Math.floor(d/86400) + "d ago"; return new Date(ms).toISOString().slice(0, 10); };
const api = async (p, opts) => { const r = await fetch(p, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
const fromUrl = () => { const u = new URLSearchParams(location.search); S.project = u.get("project") || ""; S.q = u.get("q") || ""; S.type = u.get("type") || ""; S.archived = u.get("archived") === "1"; S.page = Number(u.get("page") || 1); S.tab = u.get("tab") || "observations"; };
const toUrl = () => { const u = new URLSearchParams(); if (S.project) u.set("project", S.project); if (S.q) u.set("q", S.q); if (S.type) u.set("type", S.type); if (S.archived) u.set("archived", "1"); if (S.page > 1) u.set("page", S.page); if (S.tab !== "observations") u.set("tab", S.tab); history.replaceState(null, "", "?" + u); };

async function sidebar() {
  const j = await api("/api/projects");
  S.names = Object.fromEntries(j.projects.map((p) => [p.id, p.name]));
  const rows = [{ id: "", name: "all projects", observations: j.projects.reduce((a, p) => a + p.observations, 0) }, ...j.projects];
  $("#projects").innerHTML = rows.map((p) => '<div class="p' + (p.id === S.project ? " sel" : "") + '" data-id="' + esc(p.id) + '"><span>' + esc(p.name) + "</span><span>" + p.observations + "</span></div>").join("");
  $("#projects").querySelectorAll(".p").forEach((el) => el.onclick = () => { S.project = el.dataset.id; S.page = 1; refresh(); });
  const q = j.queue; const parts = ["pending", "processing", "failed"].filter((k) => q[k]).map((k) => "<b>" + q[k] + "</b> " + k);
  $("#queue").innerHTML = (parts.length ? parts.join("<br>") : "idle" + (q.done ? " · " + q.done + " done" : "")) + (j.lastError ? '<div class="err" title="' + esc(j.lastError) + '">last error: ' + esc(j.lastError.replace(/^\S+ \[\d+\] /, "")) + "</div>" : "");
  const sel = $("#type"); const cur = sel.value;
  sel.innerHTML = '<option value="">all types</option>' + j.types.map((t) => '<option value="' + esc(t.type) + '">' + esc(t.type) + " (" + t.n + ")</option>").join("");
  sel.value = S.type || cur;
}

const confBar = (c) => '<span class="conf" title="confidence ' + c.toFixed(2) + '"><i style="width:' + Math.round(c * 100) + '%"></i></span>';
function obsCard(o) {
  return '<div class="card' + (o.archived ? " arch" : "") + '" data-id="' + o.id + '"><div class="top">'
    + '<span class="badge ' + esc(o.type) + '">' + esc(o.type) + "</span>"
    + '<span class="title">' + esc(o.title) + "</span>" + confBar(o.confidence)
    + '<span class="date" title="' + new Date(o.created_at).toLocaleString() + '">' + rel(o.created_at) + "</span>"
    + '<span class="actions"><button class="icon" data-act="up" title="useful (alpha+2)">▲</button><button class="icon" data-act="down" title="wrong or stale (beta+3)">▼</button><button class="icon" data-act="edit" title="edit">✎</button><button class="icon" data-act="arch" title="' + (o.archived ? "unarchive" : "archive") + '">' + (o.archived ? "⤴" : "⤵") + "</button></span></div>"
    + '<div class="narr">' + esc(o.narrative) + "</div>"
    + (o.facts.length ? '<ul class="facts">' + o.facts.map((f) => "<li>" + esc(f) + "</li>").join("") + "</ul>" : "")
    + '<div class="row"><span>#' + o.id + "</span><span>" + esc(S.names[o.project_id] || o.project_id) + "</span>" + (o.files.length ? '<span class="files">' + esc(o.files.join("  ")) + "</span>" : "") + (o.archived ? "<span>archived</span>" : "") + "</div></div>";
}
const sumCard = (s) => '<div class="card"><div class="top"><span class="badge">session</span><span class="title">' + esc(s.request) + '</span><span class="date">' + rel(s.created_at) + "</span></div><dl><dt>completed</dt><dd>" + esc(s.completed) + "</dd><dt>learned</dt><dd>" + esc(s.learned) + "</dd><dt>next</dt><dd>" + esc(s.next_steps) + '</dd></dl><div class="row"><span>' + esc(S.names[s.project_id] || s.project_id) + "</span></div></div>";
const ctxCard = (c) => '<div class="card ctx"><div class="top"><span class="badge">session start</span><span class="title">' + esc(S.names[c.project_id] || c.project_id) + '</span><span class="date">' + c.tokens + " tokens · " + rel(c.created_at) + '</span></div><div class="q">query: ' + esc(c.query) + "</div><ol>" + c.items.map((i) => "<li>" + esc(i.kind === "observation" ? "#" + i.id : "session") + " " + esc(i.title) + '<span class="sc">' + (i.score != null ? i.score.toFixed(3) : "") + "</span></li>").join("") + '</ol><div class="row"><span>' + esc(c.session) + "</span></div></div>";
function editForm(o) {
  return '<div class="card edit" data-id="' + o.id + '"><input class="t-in" value="' + esc(o.title) + '" maxlength="200"><textarea class="n-in">' + esc(o.narrative) + '</textarea><textarea class="facts-in" placeholder="one fact per line">' + esc(o.facts.join(NL)) + '</textarea><div class="row"><button class="primary" data-act="save">save</button><button data-act="cancel">cancel</button></div></div>';
}
const digCard = (d) => '<div class="card"><div class="top"><span class="badge">digest</span><span class="title">' + new Date(d.period_start).toISOString().slice(0, 10) + " → " + new Date(d.period_end).toISOString().slice(0, 10) + '</span><span class="date">' + d.source_count + ' observations</span></div><div class="md">' + esc(d.content) + '</div><div class="row"><span>' + esc(S.names[d.project_id] || d.project_id) + "</span></div></div>";

async function list() {
  const list = $("#list"); const pager = $("#pager");
  const pq = S.project ? "project=" + encodeURIComponent(S.project) : "";
  try {
    if (S.tab !== "observations") {
      const j = await api("/api/" + S.tab + "?" + pq);
      $("#count").textContent = j.items.length + " " + ({ summaries: "sessions", digests: "digests", context: "session starts" })[S.tab];
      $("#hint").textContent = "";
      const card = { summaries: sumCard, digests: digCard, context: ctxCard }[S.tab];
      list.innerHTML = j.items.length ? j.items.map(card).join("") : '<div class="empty">nothing here yet' + (S.tab === "digests" ? " — digests are written for observations older than 30 days" : S.tab === "context" ? " — each Claude Code session start that received memory is listed here" : "") + "</div>";
      pager.innerHTML = ""; return;
    }
    const u = new URLSearchParams(); if (S.project) u.set("project", S.project); if (S.q) u.set("q", S.q); if (S.type) u.set("type", S.type); if (S.archived) u.set("archived", "1"); u.set("page", S.page);
    const j = await api("/api/observations?" + u);
    const pages = Math.max(1, Math.ceil(j.total / j.pageSize));
    $("#count").textContent = j.total + " observation" + (j.total === 1 ? "" : "s") + (S.q ? " ranked for “" + S.q + "”" : "");
    $("#hint").textContent = S.q ? "same ranking as session injection" : "newest first";
    for (const o of j.items) S.cache[o.id] = o;
    list.innerHTML = j.items.length ? j.items.map(obsCard).join("") : '<div class="empty">no observations' + (S.q ? " match" : " yet — they appear after the processor runs (recall status)") + "</div>";
    pager.innerHTML = pages > 1 ? '<button id="prev"' + (S.page <= 1 ? " disabled" : "") + ">‹ prev</button><span>" + S.page + " / " + pages + '</span><button id="next"' + (S.page >= pages ? " disabled" : "") + ">next ›</button>" : "";
    if ($("#prev")) $("#prev").onclick = () => { S.page--; refresh(); };
    if ($("#next")) $("#next").onclick = () => { S.page++; refresh(); };
  } catch (e) { list.innerHTML = '<div class="empty">error: ' + esc(e.message) + "</div>"; }
}

async function refresh() { toUrl(); document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab)); $("#arch").classList.toggle("on", S.archived); await Promise.all([sidebar(), list()]); }

$("#list").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-act]"); if (!b) return;
  const card = b.closest(".card"); const id = Number(card.dataset.id);
  const act = b.dataset.act;
  try {
    if (act === "edit") { card.outerHTML = editForm(S.cache[id]); return; }
    if (act === "cancel") { card.outerHTML = obsCard(S.cache[id]); return; }
    if (act === "save") {
      const body = { id, title: card.querySelector(".t-in").value, narrative: card.querySelector(".n-in").value, facts: card.querySelector(".facts-in").value.split(NL) };
      const o = await api("/api/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      S.cache[id] = o; card.outerHTML = obsCard(o); return;
    }
    const o = act === "arch" ? await api("/api/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, archived: !card.classList.contains("arch") }) })
      : await api("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, useful: act === "up" }) });
    S.cache[id] = o; card.outerHTML = obsCard(o);
  } catch (e) { $("#hint").textContent = "error: " + e.message; }
});
$("#go").onclick = () => { S.q = $("#q").value.trim(); S.page = 1; refresh(); };
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#go").click(); });
$("#type").onchange = () => { S.type = $("#type").value; S.page = 1; refresh(); };
$("#arch").onclick = () => { S.archived = !S.archived; S.page = 1; refresh(); };
document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; S.page = 1; refresh(); });
document.addEventListener("keydown", (e) => { if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); $("#q").focus(); } });
fromUrl(); $("#q").value = S.q; refresh();
setInterval(sidebar, 15000);
})();
</script></body></html>`;
