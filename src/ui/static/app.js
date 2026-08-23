// recall memory manager — vanilla ES modules, no build step.
import { installKeys } from "./keys.js";
import * as preview from "./views/preview.js";
import * as jobs from "./views/jobs.js";
import * as health from "./views/health.js";
import * as sessions from "./views/sessions.js";

export const TYPES = ["decision", "bugfix", "feature", "change", "discovery", "refactor", "config", "other", "manual"];
export const VIEWS = {
  inbox: { label: "Inbox", key: "i", list: true },
  all: { label: "All memory", key: "a", list: true },
  pinned: { label: "Pinned", key: "p", list: true },
  archived: { label: "Archived", key: "r", list: true },
  sessions: { label: "Sessions", key: "s" },
  digests: { label: "Digests", key: "d" },
  preview: { label: "Session preview", key: "v" },
  jobs: { label: "Jobs", key: "j" },
  health: { label: "Health & transfer", key: "h" },
};

export const S = {
  view: "inbox", project: "", q: "", type: "", sort: "created", page: 1,
  items: [], total: 0, pageSize: 50, cursor: 0, selected: new Set(),
  open: null, openItem: null, editing: false, creating: false, why: null,
  projects: [], queue: {}, types: [], seenAt: 0, lastError: null, loading: false,
};

export const $ = (s, root = document) => root.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const rel = (ms) => {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
};
export const fmtDate = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

export async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? "POST" : "GET"), headers: {} };
  if (opts.body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  const r = await fetch(path, init);
  const ct = r.headers.get("content-type") || "";
  const j = ct.includes("json") ? await r.json().catch(() => ({})) : { text: await r.text() };
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

export function toast(msg, kind = "ok", ms = 3500) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}
export const oops = (e) => toast(e.message || String(e), "bad", 6000);

// ---------- routing ----------
export function go(view, extra = {}) {
  const next = { view, project: S.project, q: S.q, type: S.type, sort: S.sort, page: 1, id: VIEWS[view].list ? S.open : null, ...extra };
  const p = new URLSearchParams();
  for (const k of ["project", "q", "type"]) if (next[k]) p.set(k, next[k]);
  if (next.sort && next.sort !== "created") p.set("sort", next.sort);
  if (next.page > 1) p.set("page", next.page);
  if (next.id) p.set("id", next.id);
  const h = `#/${next.view}${p.toString() ? "?" + p : ""}`;
  if (location.hash === h) route(); else location.hash = h;
}
function fromHash() {
  const m = location.hash.match(/^#\/([a-z]+)(?:\?(.*))?$/);
  const p = new URLSearchParams(m?.[2] || "");
  S.view = m && VIEWS[m[1]] ? m[1] : "inbox";
  S.project = p.get("project") || "";
  S.q = p.get("q") || "";
  S.type = p.get("type") || "";
  S.sort = p.get("sort") || "created";
  S.page = Number(p.get("page") || 1);
  S.open = p.get("id") ? Number(p.get("id")) : null;
}
async function route() {
  fromHash();
  S.selected.clear(); S.cursor = 0; S.editing = false; S.creating = false;
  $("#q").value = S.q; $("#type").value = S.type; $("#sort").value = S.sort;
  await refreshProjects();
  await load();
}

// ---------- data ----------
export async function refreshProjects() {
  try {
    const j = await api("/api/projects");
    S.projects = j.projects; S.queue = j.queue; S.types = j.types; S.seenAt = j.seenAt; S.lastError = j.lastError;
    const sel = $("#type");
    const cur = sel.value;
    sel.innerHTML = '<option value="">all types</option>' + TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
    sel.value = cur;
    renderSide();
  } catch (e) { oops(e); }
}

export async function load() {
  const v = VIEWS[S.view];
  renderSide();
  if (v.list) {
    S.loading = true; renderMain();
    try {
      const p = new URLSearchParams();
      if (S.project) p.set("project", S.project);
      if (S.q) p.set("q", S.q);
      if (S.type) p.set("type", S.type);
      if (S.sort !== "created") p.set("sort", S.sort);
      p.set("page", S.page);
      if (S.view === "pinned") p.set("pinned", "1");
      if (S.view === "archived") p.set("archived", "1");
      if (S.view === "inbox") p.set("since", S.seenAt || 0);
      const j = await api(`/api/observations?${p}`);
      S.items = S.view === "archived" ? j.items.filter((i) => i.archived) : j.items;
      S.total = S.view === "archived" ? S.items.length : j.total;
      S.pageSize = j.pageSize;
      S.cursor = Math.min(S.cursor, Math.max(0, S.items.length - 1));
    } catch (e) { oops(e); S.items = []; S.total = 0; }
    S.loading = false;
    renderMain();
    if (S.open) await openDetail(S.open, { silent: true });
    else renderPane();
  } else {
    if (!S.openItem || S.openItem.id !== S.open) { S.open = null; S.openItem = null; }
    renderMain();
    renderPane();
  }
}

// ---------- sidebar ----------
function renderSide() {
  const inbox = S.projects.reduce((n, p) => n + (S.project && p.id !== S.project ? 0 : p.inbox), 0);
  const pinned = S.projects.reduce((n, p) => n + (S.project && p.id !== S.project ? 0 : p.pinned), 0);
  const counts = { inbox, pinned };
  const views = Object.entries(VIEWS).map(([k, v]) => `
    <div class="nav ${S.view === k ? "sel" : ""}" data-view="${k}"><span>${v.label}</span>
      <span>${counts[k] ? `<span class="n ${k === "inbox" ? "hot" : ""}">${counts[k]}</span>` : ""}<kbd>g${v.key}</kbd></span></div>`).join("");
  const projects = `<div class="nav ${!S.project ? "sel" : ""}" data-project=""><span>All projects</span><span class="n">${S.projects.reduce((n, p) => n + p.observations, 0)}</span></div>` +
    S.projects.map((p) => `<div class="nav ${S.project === p.id ? "sel" : ""}" data-project="${p.id}" title="${esc(p.root_path)}"><span>${esc(p.name)}</span><span class="n">${p.observations}</span></div>`).join("");
  const q = S.queue;
  const queue = `<div class="queue">pending <b>${q.pending || 0}</b> · processing <b>${q.processing || 0}</b> · failed <b>${q.failed || 0}</b></div>` +
    (S.lastError ? `<div class="err" title="${esc(S.lastError)}">last error: ${esc(S.lastError).slice(0, 120)}</div>` : "");
  $("#side").innerHTML = `<h2>Views</h2>${views}<h2>Projects</h2>${projects}<h2>Queue</h2>${queue}`;
  $("#brand-sub").textContent = S.project ? (S.projects.find((p) => p.id === S.project)?.name || "") : "";
}

// ---------- main ----------
function renderMain() {
  const main = $("#main");
  const v = VIEWS[S.view];
  if (!v.list) {
    const mod = { preview, jobs, health, sessions, digests: sessions }[S.view];
    main.innerHTML = "";
    mod.render(main, S.view).catch(oops);
    return;
  }
  const title = { inbox: "Inbox", all: "All memory", pinned: "Pinned", archived: "Archived" }[S.view];
  const sub = S.q ? ` · search "${esc(S.q)}"` : "";
  const seen = S.view === "inbox" ? `<button class="sm" id="seen" ${S.items.length ? "" : "disabled"}>Mark all seen</button>` : "";
  const pages = Math.max(1, Math.ceil(S.total / S.pageSize));
  const bulk = S.selected.size ? renderBulk() : "";
  const rows = S.loading ? '<div class="empty">loading…</div>' : S.items.length ? S.items.map((o, i) => renderRow(o, i)).join("") : emptyState();
  const pager = pages > 1 ? `<div class="pager"><button class="sm" data-page="${S.page - 1}" ${S.page <= 1 ? "disabled" : ""}>‹ prev</button><span>page ${S.page} / ${pages}</span><button class="sm" data-page="${S.page + 1}" ${S.page >= pages ? "disabled" : ""}>next ›</button></div>` : "";
  main.innerHTML = `<div class="meta"><h1>${title}${sub}</h1><span>${S.total} item${S.total === 1 ? "" : "s"} ${seen}</span></div>${bulk}<div id="list">${rows}</div>${pager}`;
}
function emptyState() {
  if (S.view === "inbox") return `<div class="empty">Inbox zero. New memory since your last visit will show up here.<br><span class="muted">Press <kbd>g</kbd><kbd>a</kbd> for everything, <kbd>n</kbd> to write a memory by hand.</span></div>`;
  if (S.q) return `<div class="empty">Nothing matches "${esc(S.q)}".</div>`;
  return `<div class="empty">Nothing here yet.</div>`;
}
function renderRow(o, i) {
  const cls = ["row", i === S.cursor ? "cur" : "", S.selected.has(o.id) ? "sel" : "", S.open === o.id ? "open" : "", o.archived ? "arch" : ""].join(" ");
  const snip = (o.narrative || "").split("\n")[0];
  return `<div class="${cls}" data-id="${o.id}" data-i="${i}">
    <input type="checkbox" ${S.selected.has(o.id) ? "checked" : ""} data-check="${o.id}" title="select (x)">
    <div><div class="t">${o.pinned ? '<span class="pin" title="pinned">📌</span>' : ""}<span class="badge ${esc(o.type)}">${esc(o.type)}</span><span class="title">${esc(o.title)}</span>${o.source !== "auto" ? `<span class="src">${esc(o.source)}</span>` : ""}</div>
      <div class="snip">${esc(snip)}</div></div>
    <div class="right"><span title="${fmtDate(o.created_at)}">${rel(o.created_at)}</span><span class="conf" title="confidence ${(o.confidence * 100).toFixed(0)}%"><i style="width:${(o.confidence * 100).toFixed(0)}%"></i></span></div>
  </div>`;
}
function renderBulk() {
  const n = S.selected.size;
  const projects = S.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  return `<div class="bulk"><b>${n} selected</b>
    <button class="sm" data-bulk="pin">Pin</button><button class="sm" data-bulk="unpin">Unpin</button>
    <button class="sm" data-bulk="archive">Archive</button><button class="sm" data-bulk="unarchive">Unarchive</button>
    <select id="bulk-move"><option value="">Move to…</option>${projects}</select>
    <button class="sm" data-bulk="merge" ${n < 2 ? "disabled" : ""} title="merge into one (m)">Merge</button>
    <button class="sm danger" data-bulk="delete" title="delete (d)">Delete</button>
    <span class="spacer" style="flex:1"></span><button class="sm" data-bulk="clear">Clear</button></div>`;
}

// ---------- selection / actions ----------
export const current = () => S.items[S.cursor] || null;
export function moveCursor(d) {
  if (!S.items.length) return;
  S.cursor = Math.max(0, Math.min(S.items.length - 1, S.cursor + d));
  renderMain();
  $(`.row[data-i="${S.cursor}"]`)?.scrollIntoView({ block: "nearest" });
}
export function toggleSelect(id) {
  if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
  renderMain();
}
export function selectAll() {
  if (S.selected.size === S.items.length) S.selected.clear(); else S.items.forEach((o) => S.selected.add(o.id));
  renderMain();
}
export function clearSelection() { S.selected.clear(); renderMain(); }
export const targets = () => (S.selected.size ? [...S.selected] : current() ? [current().id] : []);

export async function bulk(op, extra = {}) {
  const ids = targets();
  if (!ids.length) return;
  if (op === "delete" && !confirmArmed(`delete-${ids.join(",")}`)) { toast(`Press d / Delete again to delete ${ids.length} item(s)`, "info"); return; }
  try {
    if (op === "merge") {
      if (ids.length < 2) return toast("Select at least two items to merge", "info");
      const m = await api("/api/observations/merge", { body: { ids } });
      toast(`Merged ${ids.length} into #${m.id}`);
      S.selected.clear();
      await refreshProjects(); await load();
      await openDetail(m.id);
      return;
    }
    await api("/api/observations/bulk", { body: { ids, op, ...extra } });
    toast(`${op} · ${ids.length} item(s)`);
    if (op === "delete" && ids.includes(S.open)) closePane();
    S.selected.clear();
    await refreshProjects(); await load();
  } catch (e) { oops(e); }
}
const armed = new Map();
export function confirmArmed(key) {
  const t = armed.get(key);
  if (t && Date.now() - t < 4000) { armed.delete(key); return true; }
  armed.set(key, Date.now());
  setTimeout(() => { if (armed.get(key) && Date.now() - armed.get(key) >= 4000) { armed.delete(key); renderPane(); } }, 4100);
  return false;
}

export async function patch(id, body, msg) {
  try {
    const o = await api(`/api/observations/${id}`, { method: "PATCH", body });
    const i = S.items.findIndex((x) => x.id === id);
    if (i >= 0) S.items[i] = o;
    if (S.open === id) S.openItem = o;
    if (msg) toast(msg);
    renderMain(); renderPane();
    refreshProjects();
    return o;
  } catch (e) { oops(e); }
}
export async function feedback(id, useful) {
  try {
    const o = await api("/api/feedback", { body: { id, useful } });
    const i = S.items.findIndex((x) => x.id === id);
    if (i >= 0) S.items[i] = o;
    if (S.open === id) S.openItem = o;
    toast(useful ? "Marked useful — it will rank higher" : "Marked unhelpful — it will rank lower", "info");
    renderMain(); renderPane();
  } catch (e) { oops(e); }
}
export async function togglePin(id = current()?.id) { if (!id) return; const o = S.items.find((x) => x.id === id) || S.openItem; await patch(id, { pinned: !o.pinned }, o.pinned ? "Unpinned" : "Pinned — always included in session context"); }
export async function toggleArchive(id = current()?.id) { if (!id) return; const o = S.items.find((x) => x.id === id) || S.openItem; await patch(id, { archived: !o.archived }, o.archived ? "Restored" : "Archived — excluded from recall"); if (S.view !== "all") await load(); }
export async function markSeen() { try { await api("/api/seen", { body: {} }); toast("Inbox cleared"); await refreshProjects(); await load(); } catch (e) { oops(e); } }

// ---------- detail pane ----------
export async function openDetail(id, { silent = false, why = null } = {}) {
  try {
    S.open = id; S.editing = false; S.creating = false; S.why = why;
    S.openItem = S.items.find((x) => x.id === id) || (await api(`/api/observations/${id}`));
    const i = S.items.findIndex((x) => x.id === id);
    if (i >= 0) S.cursor = i;
    if (!silent) go(S.view, { id, page: S.page });
    $("#body").classList.add("pane-open");
    renderMain(); renderPane();
  } catch (e) { oops(e); }
}
export function closePane() {
  S.open = null; S.openItem = null; S.editing = false; S.creating = false; S.why = null;
  $("#body").classList.remove("pane-open");
  go(S.view, { id: null, page: S.page });
}
export function startCreate() {
  S.creating = true; S.editing = true; S.open = null; S.why = null;
  S.openItem = { id: 0, project_id: S.project || S.projects[0]?.id || "", type: "manual", title: "", narrative: "", facts: [], files: [], pinned: false, archived: false, source: "manual", confidence: 0.5, created_at: Date.now() };
  $("#body").classList.add("pane-open");
  renderPane();
  setTimeout(() => $("#f-title")?.focus(), 0);
}
export function startEdit() { if (!S.openItem) return; S.editing = true; renderPane(); setTimeout(() => $("#f-title")?.focus(), 0); }
export function cancelEdit() { if (S.creating) return closePane(); S.editing = false; renderPane(); }
export async function saveEdit() {
  const body = {
    title: $("#f-title").value, narrative: $("#f-narr").value, type: $("#f-type").value, project_id: $("#f-project").value,
    facts: $("#f-facts").value.split("\n").map((s) => s.trim()).filter(Boolean),
    files: $("#f-files").value.split("\n").map((s) => s.trim()).filter(Boolean),
    pinned: $("#f-pinned").checked,
  };
  try {
    if (S.creating) {
      const o = await api("/api/observations", { body });
      toast("Memory saved");
      S.creating = false; S.editing = false;
      await refreshProjects(); await load();
      await openDetail(o.id);
    } else {
      await patch(S.open, body, "Saved");
      S.editing = false; renderPane();
    }
  } catch (e) { oops(e); }
}
export async function deleteOpen(id = S.open) {
  if (!id) return;
  if (!confirmArmed(`delete-${id}`)) { renderPane(); toast("Press again to confirm delete", "info"); return; }
  try {
    await api(`/api/observations/${id}`, { method: "DELETE" });
    toast("Deleted");
    closePane();
    await refreshProjects(); await load();
  } catch (e) { oops(e); }
}

export function renderPane() {
  const pane = $("#pane");
  const o = S.openItem;
  if (!o) { pane.innerHTML = ""; $("#body").classList.remove("pane-open"); return; }
  $("#body").classList.add("pane-open");
  const projects = S.projects.map((p) => `<option value="${p.id}" ${p.id === o.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const types = TYPES.map((t) => `<option ${t === o.type ? "selected" : ""}>${t}</option>`).join("");
  if (S.editing) {
    pane.innerHTML = `<div class="head"><b>${S.creating ? "New memory" : `Edit #${o.id}`}</b><span class="spacer"></span>
        <button class="sm" id="p-cancel" title="Esc">Cancel</button><button class="sm primary" id="p-save" title="Ctrl+Enter">Save</button></div>
      <div class="content">
        <div class="field"><label>Title</label><input id="f-title" value="${esc(o.title)}" maxlength="200" placeholder="Short, specific"></div>
        <div class="field"><label>Narrative</label><textarea id="f-narr" placeholder="What a future session should know. Past tense, concrete identifiers.">${esc(o.narrative)}</textarea></div>
        <div class="field"><label>Facts — one per line</label><textarea id="f-facts" class="mono">${esc(o.facts.join("\n"))}</textarea></div>
        <div class="field"><label>Files — one per line</label><textarea id="f-files" class="mono" style="min-height:3.5rem">${esc(o.files.join("\n"))}</textarea></div>
        <div class="two"><div class="field"><label>Type</label><select id="f-type">${types}</select></div><div class="field"><label>Project</label><select id="f-project">${projects}</select></div></div>
        <label><input type="checkbox" id="f-pinned" ${o.pinned ? "checked" : ""}> Pinned — always included in session context</label>
        <div class="muted" style="font-size:12px">Save with <kbd>Ctrl</kbd>+<kbd>Enter</kbd>, cancel with <kbd>Esc</kbd></div>
      </div>`;
    $("#p-save").onclick = saveEdit; $("#p-cancel").onclick = cancelEdit;
    return;
  }
  const delArmed = armed.has(`delete-${o.id}`) && Date.now() - armed.get(`delete-${o.id}`) < 4000;
  const why = S.why ? `<div class="why"><b>Why this was recalled</b> · score ${S.why.score}<div class="chips">${whyChips(S.why.why)}</div></div>` : "";
  pane.innerHTML = `<div class="head">
      <span class="badge ${esc(o.type)}">${esc(o.type)}</span>${o.pinned ? '<span class="pin">📌 pinned</span>' : ""}${o.archived ? '<span class="badge">archived</span>' : ""}<span class="src">${esc(o.source)}</span>
      <span class="spacer"></span>
      <button class="sm" id="p-edit" title="e">Edit</button>
      <button class="sm ${o.pinned ? "on" : ""}" id="p-pin" title="p">${o.pinned ? "Unpin" : "Pin"}</button>
      <button class="sm" id="p-arch" title="a">${o.archived ? "Restore" : "Archive"}</button>
      <button class="sm danger ${delArmed ? "armed" : ""}" id="p-del" title="d">${delArmed ? "Really delete?" : "Delete"}</button>
      <button class="sm" id="p-close" title="Esc">✕</button></div>
    <div class="content">
      <h3>${esc(o.title)}</h3>
      ${why}
      <div class="narr">${esc(o.narrative)}</div>
      ${o.facts.length ? `<ul class="facts">${o.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      ${o.files.length ? `<div class="files">${o.files.map(esc).join("<br>")}</div>` : ""}
      <dl><dt>id</dt><dd>#${o.id}</dd><dt>project</dt><dd>${esc(S.projects.find((p) => p.id === o.project_id)?.name || o.project_id)}</dd>
        <dt>created</dt><dd>${fmtDate(o.created_at)}</dd>
        <dt>confidence</dt><dd><span class="conf"><i style="width:${(o.confidence * 100).toFixed(0)}%"></i></span> ${(o.confidence * 100).toFixed(0)}% <span class="muted">(α ${o.alpha?.toFixed(1)} β ${o.beta?.toFixed(1)})</span></dd>
        <dt>embedding</dt><dd>${o.embedded ? "yes" : '<span class="muted">pending</span>'}</dd></dl>
      <div class="toggles"><button class="sm" id="p-up" title="f">👍 useful</button><button class="sm" id="p-down" title="F">👎 not useful</button></div>
    </div>`;
  $("#p-edit").onclick = startEdit; $("#p-pin").onclick = () => togglePin(o.id); $("#p-arch").onclick = () => toggleArchive(o.id);
  $("#p-del").onclick = () => deleteOpen(o.id); $("#p-close").onclick = closePane;
  $("#p-up").onclick = () => feedback(o.id, true); $("#p-down").onclick = () => feedback(o.id, false);
}
export function whyChips(w) {
  if (!w) return "";
  const c = [];
  if (w.fts) c.push(`keyword #${w.fts}`);
  if (w.vec) c.push(`semantic #${w.vec}`);
  if (w.recent) c.push(`recent #${w.recent}`);
  c.push(`recency ×${(0.5 + 0.5 * w.recency).toFixed(2)}`, `confidence ×${(0.5 + w.confidence).toFixed(2)}`);
  return c.map((x) => `<span class="chip">${x}</span>`).join("");
}

// ---------- help ----------
export function toggleHelp() {
  const ov = $("#overlay");
  if (ov.innerHTML) { ov.innerHTML = ""; return; }
  const rows = [
    ["j / k", "move cursor"], ["Enter / o", "open"], ["x", "select"], ["Shift+X", "select all / none"], ["e", "edit"], ["n", "new memory"],
    ["p", "pin / unpin"], ["a", "archive / restore"], ["d", "delete (press twice)"], ["m", "merge selected"], ["f / F", "useful / not useful"],
    ["/", "search"], ["g then i a p r s d v j h", "jump to view"], ["Esc", "close pane / clear selection"], ["?", "this help"],
  ];
  ov.innerHTML = `<div class="overlay"><div class="help"><h2>Keyboard</h2><div class="cols">${rows.map(([k, v]) => `<div><span>${v}</span><kbd>${k}</kbd></div>`).join("")}</div></div></div>`;
  ov.firstElementChild.onclick = (e) => { if (e.target === ov.firstElementChild) ov.innerHTML = ""; };
}

// ---------- events ----------
function wire() {
  const q = $("#q");
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.q = q.value.trim(); go(VIEWS[S.view].list ? S.view : "all"); }, 250); };
  q.onkeydown = (e) => { if (e.key === "Escape") { q.value = ""; S.q = ""; q.blur(); go(S.view); } if (e.key === "Enter") { clearTimeout(t); S.q = q.value.trim(); go(VIEWS[S.view].list ? S.view : "all"); q.blur(); } };
  $("#type").onchange = (e) => { S.type = e.target.value; go(VIEWS[S.view].list ? S.view : "all"); };
  $("#sort").onchange = (e) => { S.sort = e.target.value; go(S.view); };
  $("#new").onclick = startCreate;
  $("#help").onclick = toggleHelp;
  $("#side").onclick = (e) => {
    const v = e.target.closest("[data-view]"); if (v) return go(v.dataset.view, { id: null });
    const p = e.target.closest("[data-project]"); if (p) { S.project = p.dataset.project; return go(S.view, { id: null }); }
  };
  $("#main").onclick = (e) => {
    const cb = e.target.closest("[data-check]"); if (cb) { toggleSelect(Number(cb.dataset.check)); return; }
    const b = e.target.closest("[data-bulk]");
    if (b) { const op = b.dataset.bulk; if (op === "clear") return clearSelection(); return bulk(op); }
    const pg = e.target.closest("[data-page]"); if (pg && !pg.disabled) return go(S.view, { page: Number(pg.dataset.page) });
    if (e.target.id === "seen") return markSeen();
    const row = e.target.closest(".row[data-id]"); if (row) { S.cursor = Number(row.dataset.i); openDetail(Number(row.dataset.id)); }
  };
  $("#main").onchange = (e) => { if (e.target.id === "bulk-move" && e.target.value) bulk("move", { project_id: e.target.value }); };
  $("#pane").onkeydown = (e) => {
    if (!S.editing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(); }
    if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
  };
  window.addEventListener("hashchange", route);
  installKeys();
}

wire();
route();
