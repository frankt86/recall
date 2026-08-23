// Session summaries and project digests: list, inline edit, delete.
import { $, S, api, esc, oops, toast, fmtDate, confirmArmed } from "../app.js";

const FIELDS = {
  sessions: { table: "summaries", title: "Sessions", fields: [["request", "Request"], ["completed", "Completed"], ["learned", "Learned"], ["next_steps", "Next steps"]], when: (r) => r.created_at },
  digests: { table: "digests", title: "Digests", fields: [["content", "Digest (markdown)"]], when: (r) => r.period_end },
};

export async function render(main, view) {
  const cfg = FIELDS[view];
  main.innerHTML = `<div class="meta"><h1>${cfg.title}${S.project ? "" : " · all projects"}</h1><span id="ss-count"></span></div><div id="ss"></div>`;
  let editing = null;
  await draw();

  async function draw() {
    try {
      const { items } = await api(`/api/${cfg.table}${S.project ? `?project=${encodeURIComponent(S.project)}` : ""}`);
      $("#ss-count").textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
      $("#ss").innerHTML = items.length ? items.map(card).join("") : `<div class="empty">No ${cfg.title.toLowerCase()} yet.</div>`;
      $("#ss").onclick = async (e) => {
        const b = e.target.closest("[data-op]"); if (!b) return;
        const id = Number(b.dataset.id);
        const op = b.dataset.op;
        if (op === "edit") { editing = id; return draw(); }
        if (op === "cancel") { editing = null; return draw(); }
        if (op === "save") {
          const body = {};
          for (const [f] of cfg.fields) body[f] = $(`#sf-${f}`).value;
          try { await api(`/api/${cfg.table}/${id}`, { method: "PATCH", body }); toast("Saved"); editing = null; draw(); } catch (err) { oops(err); }
          return;
        }
        if (op === "delete") {
          if (!confirmArmed(`${cfg.table}-${id}`)) { b.classList.add("armed"); b.textContent = "Really delete?"; setTimeout(() => { if (document.body.contains(b)) { b.classList.remove("armed"); b.textContent = "Delete"; } }, 4000); return; }
          try { await api(`/api/${cfg.table}/${id}`, { method: "DELETE" }); toast("Deleted"); draw(); } catch (err) { oops(err); }
        }
      };
    } catch (e) { $("#ss").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  function card(r) {
    const proj = S.projects.find((p) => p.id === r.project_id)?.name || r.project_id;
    const head = `<div class="muted" style="font-size:12px">${fmtDate(cfg.when(r))} · ${esc(proj)}${r.source_count ? ` · ${r.source_count} sources` : ""} · #${r.id}</div>`;
    if (editing === r.id) {
      return `<div class="card">${head}${cfg.fields.map(([f, label]) => `<label class="muted" style="font-size:12px;display:block;margin-top:.4rem">${label}</label><textarea id="sf-${f}" class="${f === "content" ? "mono" : ""}" style="width:100%;min-height:${f === "content" ? "16rem" : "4rem"}">${esc(r[f])}</textarea>`).join("")}
        <div class="row-actions"><button class="sm primary" data-op="save" data-id="${r.id}">Save</button><button class="sm" data-op="cancel" data-id="${r.id}">Cancel</button></div></div>`;
    }
    const body = view === "sessions"
      ? `<h3>${esc(r.request)}</h3><dl><dt>completed</dt><dd>${esc(r.completed)}</dd><dt>learned</dt><dd>${esc(r.learned)}</dd><dt>next</dt><dd>${esc(r.next_steps)}</dd></dl>`
      : `<div class="md">${esc(r.content)}</div>`;
    return `<div class="card">${head}${body}<div class="row-actions"><button class="sm" data-op="edit" data-id="${r.id}">Edit</button><button class="sm danger" data-op="delete" data-id="${r.id}">Delete</button></div></div>`;
  }
}
