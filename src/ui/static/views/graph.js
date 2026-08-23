// Knowledge graph: force-directed SVG of entities extracted from active memory. Click a node for its memories.
import { $, S, api, esc, oops, toast, openDetail, refreshProjects, rel } from "../app.js";

const KINDS = ["file", "symbol", "command", "library", "concept"];
const COLOR = { file: "#7ea3ff", symbol: "#4cc27a", command: "#e0b25a", library: "#d38bff", concept: "#ff8a7a" };
let sim = null;

export async function render(main) {
  stop();
  const pid = S.project || S.projects[0]?.id || "";
  const projects = S.projects.map((p) => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  main.innerHTML = `<div class="meta"><h1>Knowledge graph</h1><span class="actions">
      <select id="gr-project">${projects}</select>
      <input id="gr-q" placeholder="filter names" style="width:10rem">
      <label class="muted">min <input id="gr-min" type="number" min="1" value="1" style="width:3.5rem"></label>
      ${KINDS.map((k) => `<label class="muted" style="display:inline-flex;align-items:center;gap:.2rem"><input type="checkbox" class="gr-kind" value="${k}" checked><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${COLOR[k]}"></i>${k}</label>`).join("")}
      <button class="sm" id="gr-rebuild" title="re-extract entities from all active observations">Rebuild</button></span></div>
    <div class="graph-wrap"><svg id="gr-svg"></svg><div class="graph-side" id="gr-side"><div class="empty">Click a node to see its memories.<br><span class="muted">Drag to move · scroll to zoom · double-click to reset</span></div></div></div>`;
  if (!pid) { $("#gr-svg").outerHTML = '<div class="empty">No projects yet.</div>'; return; }
  const redraw = debounce(draw, 250);
  $("#gr-project").onchange = (e) => { S.project = e.target.value; refreshProjects(); draw(); };
  $("#gr-q").oninput = redraw; $("#gr-min").onchange = draw;
  main.querySelectorAll(".gr-kind").forEach((c) => (c.onchange = draw));
  $("#gr-rebuild").onclick = async () => { try { const r = await api("/api/actions/regraph", { body: { project: $("#gr-project").value } }); toast(r.message); draw(); } catch (e) { oops(e); } };
  await draw();

  async function draw() {
    stop();
    const project = $("#gr-project").value;
    const kinds = [...main.querySelectorAll(".gr-kind:checked")].map((c) => c.value);
    const q = $("#gr-q").value.trim();
    const min = Math.max(1, Number($("#gr-min").value) || 1);
    let g;
    try { g = await api(`/api/graph?project=${encodeURIComponent(project)}&kinds=${kinds.join(",")}&min=${min}&q=${encodeURIComponent(q)}&limit=200`); } catch (e) { return oops(e); }
    const svg = $("#gr-svg");
    if (!g.nodes.length) { svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--muted)">No entities yet — memory is linked as it is observed. Click Rebuild to extract from existing memory.</text>`; return; }
    forceLayout(svg, g, (node) => showEntity(node));
  }

  async function showEntity(node) {
    const side = $("#gr-side");
    side.innerHTML = '<div class="empty">loading…</div>';
    try {
      const e = await api(`/api/graph/entity/${node.id}`);
      side.innerHTML = `<div class="ent-head"><span class="badge" style="color:${COLOR[e.entity.kind]}">${esc(e.entity.kind)}</span> <b class="mono">${esc(e.entity.name)}</b>
          <div class="muted" style="font-size:12px">${e.observations.length} memor${e.observations.length === 1 ? "y" : "ies"} · last seen ${rel(e.entity.last_seen)}</div></div>
        ${e.neighbors.length ? `<div class="section"><h2>Related</h2><div class="chips">${e.neighbors.slice(0, 16).map((n) => `<span class="chip" data-ent="${n.id}" style="cursor:pointer;border-left:3px solid ${COLOR[n.kind]}" title="${esc(n.rel)} · weight ${n.weight.toFixed(1)}">${esc(n.name)}</span>`).join("")}</div></div>` : ""}
        <div class="section"><h2>Memories</h2>${e.observations.map((o) => `<div class="row" data-obs="${o.id}" style="grid-template-columns:minmax(0,1fr) auto"><div><div class="t">${o.pinned ? "📌 " : ""}<span class="badge ${esc(o.type)}">${esc(o.type)}</span><span class="title">${esc(o.title)}</span></div><div class="snip">${esc((o.narrative || "").split("\n")[0])}</div></div><div class="right"><span>${rel(o.created_at)}</span></div></div>`).join("") || '<div class="muted">none active</div>'}</div>`;
      side.onclick = (ev) => {
        const c = ev.target.closest("[data-ent]"); if (c) return showEntity({ id: Number(c.dataset.ent) });
        const r = ev.target.closest("[data-obs]"); if (r) openDetail(Number(r.dataset.obs), { silent: true });
      };
    } catch (err) { side.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  }
}

function stop() { if (sim) { cancelAnimationFrame(sim); sim = null; } }
function debounce(f, ms) { let t; return () => { clearTimeout(t); t = setTimeout(f, ms); }; }

// Minimal force simulation: repulsion between all nodes, springs along edges, gravity to centre.
function forceLayout(svg, g, onClick) {
  const W = svg.clientWidth || 800, H = svg.clientHeight || 600;
  const maxM = Math.max(...g.nodes.map((n) => n.mentions));
  const nodes = g.nodes.map((n, i) => ({ ...n, x: W / 2 + Math.cos(i) * 120 * Math.random(), y: H / 2 + Math.sin(i) * 120 * Math.random(), vx: 0, vy: 0, r: 4 + 10 * Math.sqrt(n.mentions / maxM) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = g.edges.filter((e) => byId.has(e.src) && byId.has(e.dst)).map((e) => ({ ...e, a: byId.get(e.src), b: byId.get(e.dst) }));
  const NS = "http://www.w3.org/2000/svg";
  svg.innerHTML = "";
  const root = document.createElementNS(NS, "g");
  svg.appendChild(root);
  const el = (tag, attrs) => { const x = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v); return x; };
  const lines = edges.map((e) => { const l = el("line", { stroke: "var(--line)", "stroke-width": Math.min(4, 0.6 + e.weight * 0.5), opacity: e.rel === "co_occurs" ? 0.5 : 0.9 }); l.appendChild(el("title", {})).textContent = `${e.a.name} —${e.rel}→ ${e.b.name} (${e.weight.toFixed(1)})`; root.appendChild(l); return l; });
  const circles = nodes.map((n) => {
    const gEl = el("g", { cursor: "pointer" });
    const c = el("circle", { r: n.r, fill: COLOR[n.kind] || "#999", stroke: "var(--panel)", "stroke-width": 1.5 });
    const t = el("text", { "font-size": n.mentions >= maxM / 3 || nodes.length < 40 ? 11 : 9, fill: "var(--ink)", dx: n.r + 3, dy: 4 });
    t.textContent = n.name.length > 28 ? "…" + n.name.slice(-27) : n.name;
    gEl.appendChild(c); gEl.appendChild(t);
    gEl.appendChild(el("title", {})).textContent = `${n.kind}: ${n.name} · ${n.mentions} memories`;
    gEl.onclick = (ev) => { ev.stopPropagation(); onClick(n); };
    root.appendChild(gEl);
    return gEl;
  });

  // pan/zoom/drag
  let scale = 1, tx = 0, ty = 0, drag = null, pan = null;
  const apply = () => root.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
  svg.onwheel = (e) => { e.preventDefault(); const k = e.deltaY < 0 ? 1.1 : 0.9; const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; tx = mx - (mx - tx) * k; ty = my - (my - ty) * k; scale *= k; apply(); };
  svg.ondblclick = () => { scale = 1; tx = 0; ty = 0; apply(); };
  circles.forEach((c, i) => { c.onmousedown = (e) => { e.stopPropagation(); drag = nodes[i]; drag.fixed = true; }; });
  svg.onmousedown = (e) => { pan = { x: e.clientX - tx, y: e.clientY - ty }; };
  window.onmousemove = (e) => {
    if (drag) { const r = svg.getBoundingClientRect(); drag.x = (e.clientX - r.left - tx) / scale; drag.y = (e.clientY - r.top - ty) / scale; alpha = Math.max(alpha, 0.3); }
    else if (pan) { tx = e.clientX - pan.x; ty = e.clientY - pan.y; apply(); }
  };
  window.onmouseup = () => { if (drag) drag.fixed = false; drag = null; pan = null; };

  let alpha = 1;
  const tick = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy + 0.01;
        const f = (350 * alpha) / d2;
        dx *= f; dy *= f; a.vx -= dx; a.vy -= dy; b.vx += dx; b.vy += dy;
      }
      a.vx += (W / 2 - a.x) * 0.035 * alpha; a.vy += (H / 2 - a.y) * 0.035 * alpha;
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1;
      const f = ((d - 60) / d) * 0.08 * alpha * Math.min(2, 0.5 + e.weight * 0.3);
      e.a.vx += dx * f; e.a.vy += dy * f; e.b.vx -= dx * f; e.b.vy -= dy * f;
    }
    for (const n of nodes) { if (n.fixed) { n.vx = n.vy = 0; continue; } n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy; }
    lines.forEach((l, i) => { const e = edges[i]; l.setAttribute("x1", e.a.x); l.setAttribute("y1", e.a.y); l.setAttribute("x2", e.b.x); l.setAttribute("y2", e.b.y); });
    circles.forEach((c, i) => c.setAttribute("transform", `translate(${nodes[i].x},${nodes[i].y})`));
    alpha *= 0.985;
    if (alpha > 0.003 || drag) sim = requestAnimationFrame(tick); else sim = null;
  };
  sim = requestAnimationFrame(tick);
}
