// Background job queue: inspect, retry, cancel, and trigger processor actions.
import { $, S, api, esc, oops, toast, rel, refreshProjects } from "../app.js";

let timer = null;

export async function render(main) {
  clearInterval(timer);
  main.innerHTML = `<div class="meta"><h1>Jobs</h1><span class="actions">
      <select id="jb-status"><option value="">all statuses</option><option>pending</option><option>processing</option><option>failed</option><option>done</option></select>
      <button class="sm" data-action="process" title="run the queue now, in this server process">▶ Run queue</button>
      <button class="sm" data-action="consolidate" title="queue a digest pass over old observations">Consolidate</button>
      <button class="sm" data-action="reembed" title="queue embeddings for observations that have none">Re-embed missing</button>
    </span></div><div id="jb"></div>`;
  $("#jb-status").onchange = draw;
  main.onclick = async (e) => {
    const a = e.target.closest("[data-action]");
    if (a) {
      a.disabled = true; a.textContent = "working…";
      try {
        const r = await api(`/api/actions/${a.dataset.action}`, { body: { project: S.project || undefined } });
        toast(r.message, "info", 5000);
      } catch (err) { oops(err); }
      render(main);
      refreshProjects();
      return;
    }
    const j = e.target.closest("[data-job]");
    if (j) {
      try { await api(`/api/jobs/${j.dataset.job}/${j.dataset.op}`, { body: {} }); toast(`${j.dataset.op} · job #${j.dataset.job}`); draw(); refreshProjects(); } catch (err) { oops(err); }
    }
  };
  await draw();
  timer = setInterval(() => { if (!document.body.contains(main) || S.view !== "jobs") return clearInterval(timer); draw(); }, 5000);

  async function draw() {
    const status = $("#jb-status")?.value || "";
    try {
      const { items } = await api(`/api/jobs${status ? `?status=${status}` : ""}`);
      const rows = items.map((j) => `<tr>
        <td class="num">#${j.id}</td><td>${esc(j.kind)}</td><td class="num">${j.ref_id}</td>
        <td><span class="status ${esc(j.status)}">${esc(j.status)}</span></td><td class="num">${j.attempts}</td>
        <td title="${new Date(j.created_at).toISOString()}">${rel(j.created_at)}</td>
        <td class="err-cell">${esc(j.error || "")}</td>
        <td>${j.status !== "done" ? `<button class="sm" data-job="${j.id}" data-op="retry">Retry</button>` : ""} ${j.status === "pending" || j.status === "processing" ? `<button class="sm danger" data-job="${j.id}" data-op="cancel">Cancel</button>` : ""}</td>
      </tr>`).join("");
      $("#jb").innerHTML = items.length
        ? `<table><thead><tr><th>id</th><th>kind</th><th>ref</th><th>status</th><th>tries</th><th>age</th><th>error</th><th></th></tr></thead><tbody>${rows}</tbody></table><p class="muted" style="font-size:12px">Showing the latest ${items.length}. Auto-refreshes every 5 s.</p>`
        : '<div class="empty">No jobs.</div>';
    } catch (e) { $("#jb").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
}
