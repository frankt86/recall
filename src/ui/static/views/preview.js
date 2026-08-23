// Session preview: exactly what the SessionStart hook will inject for a project, with per-item score breakdown.
import { $, S, api, esc, oops, toast, openDetail, whyChips, refreshProjects, fmtDate } from "../app.js";

export async function render(main) {
  const pid = S.project || S.projects[0]?.id || "";
  const projects = S.projects.map((p) => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  main.innerHTML = `<div class="meta"><h1>Session preview</h1><span class="actions"><label class="muted">project</label><select id="pv-project">${projects}</select><button class="sm" id="pv-refresh">Refresh</button></span></div>
    <div class="preview" id="pv"><div class="empty">loading…</div></div>`;
  $("#pv-project").onchange = (e) => { S.project = e.target.value; refreshProjects(); draw(); };
  $("#pv-refresh").onclick = draw;
  if (!pid) { $("#pv").innerHTML = '<div class="empty">No projects yet.</div>'; return; }
  await draw();

  async function draw() {
    const project = $("#pv-project").value;
    const box = $("#pv");
    try {
      const j = await api(`/api/preview?project=${encodeURIComponent(project)}`);
      const pct = Math.min(100, Math.round((j.tokens / j.budget) * 100));
      const cls = pct >= 100 ? "over" : pct >= 90 ? "warn" : "";
      const rows = j.items.map((it) => `
        <tr class="clickable" data-kind="${it.kind}" data-id="${it.id}">
          <td>${it.pinned ? "📌 " : ""}<span class="badge ${esc(it.type)}">${esc(it.type)}</span></td>
          <td><b>${esc(it.title)}</b><div class="muted" style="font-size:11.5px">${it.kind} · ${fmtDate(it.created_at)}</div></td>
          <td class="num">${it.pinned ? "pinned" : it.score.toFixed(4)}</td>
          <td><div class="chips">${whyChips(it.why)}</div></td>
          <td>${it.kind === "observation" ? `<button class="sm" data-pin="${it.id}" data-pinned="${it.pinned ? 1 : 0}">${it.pinned ? "Unpin" : "Pin"}</button> <button class="sm" data-exclude="${it.id}">Exclude</button>` : ""}</td>
        </tr>`).join("");
      const skipped = j.skippedPinned.length
        ? `<div class="amber">Pinned but over budget (will NOT be injected): ${j.skippedPinned.map((s) => `<b>#${s.id}</b> ${esc(s.title)}`).join(", ")}. Raise <code>contextTokenBudget</code> or unpin something.</div>`
        : "";
      box.innerHTML = `
        <div class="meter"><span><b>${j.tokens}</b> / ${j.budget} tokens</span><span class="bar"><i class="${cls}" style="width:${pct}%"></i></span><span>${j.items.length} / ${j.maxItems} items${j.pending ? ` · ${j.pending} jobs pending` : ""}</span></div>
        <p class="muted" style="font-size:12px;margin:.4rem 0">Query signal: <span class="mono">${esc(j.query || "(none)")}</span> — derived from branch + recently modified files, the same way the hook does it.</p>
        ${skipped}
        ${j.text ? `<pre>${esc(j.text)}</pre>` : '<div class="empty">Nothing would be injected for this project yet.</div>'}
        <div class="section"><h2>Contributing items</h2>
        ${j.items.length ? `<table><thead><tr><th>type</th><th>item</th><th>score</th><th>why</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted">none</div>'}</div>`;
      box.onclick = async (e) => {
        const pin = e.target.closest("[data-pin]");
        if (pin) { e.stopPropagation(); await api(`/api/observations/${pin.dataset.pin}`, { method: "PATCH", body: { pinned: pin.dataset.pinned !== "1" } }).then(() => { toast(pin.dataset.pinned === "1" ? "Unpinned" : "Pinned"); draw(); }).catch(oops); return; }
        const ex = e.target.closest("[data-exclude]");
        if (ex) { e.stopPropagation(); await api(`/api/observations/${ex.dataset.exclude}`, { method: "PATCH", body: { archived: true } }).then(() => { toast("Archived — excluded from recall"); draw(); refreshProjects(); }).catch(oops); return; }
        const tr = e.target.closest("tr[data-id]");
        if (tr && tr.dataset.kind === "observation") {
          const it = j.items.find((x) => x.kind === "observation" && x.id === Number(tr.dataset.id));
          openDetail(Number(tr.dataset.id), { silent: true, why: it });
        }
      };
    } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
}
