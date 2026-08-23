// Health: database stats, settings, and markdown/JSON export + import.
import { $, S, api, esc, oops, toast, refreshProjects, go } from "../app.js";

const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

export async function render(main) {
  main.innerHTML = '<div class="meta"><h1>Health &amp; transfer</h1></div><div id="hl"><div class="empty">loading…</div></div>';
  try {
    const h = await api("/api/health");
    const pid = S.project || S.projects[0]?.id || "";
    const projects = S.projects.map((p) => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    const cov = h.embeddable ? Math.round((h.embedded / h.embeddable) * 100) : 100;
    const stats = [
      ["observations", h.counts.observations], ["sessions", h.counts.summaries], ["digests", h.counts.digests], ["jobs", h.counts.jobs],
      ["embedding coverage", `${cov}%`], ["database", kb(h.dbBytes)],
    ].map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");
    const settings = Object.entries(h.settings).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(Array.isArray(v) ? v.join(", ") || "—" : String(v))}</dd>`).join("");
    $("#hl").innerHTML = `
      <div class="grid">${stats}</div>
      <p class="muted" style="font-size:12px">DB: <span class="mono">${esc(h.dbPath)}</span> · embeddings ${h.embeddingsEnabled ? (h.embeddingsReady ? "ready" : "enabled, model not loaded yet") : "disabled"}${h.lastError ? ` · <span style="color:var(--bad)">last error: ${esc(h.lastError)}</span>` : ""}</p>

      <div class="section xfer"><h2>Export</h2>
        <div class="actions"><select id="ex-project">${projects}</select><select id="ex-format"><option value="md">markdown</option><option value="json">json</option></select>
        <a id="ex-link" class="sm" href="#"><button class="sm">Download</button></a><span class="muted" style="font-size:12px">Active (non-archived) memory for the project. Markdown is hand-editable and re-importable.</span></div></div>

      <div class="section xfer"><h2>Import</h2>
        <div class="actions" style="margin-bottom:.4rem"><select id="im-project">${projects}</select><select id="im-format"><option value="md">markdown</option><option value="json">json</option></select>
        <input type="file" id="im-file" accept=".md,.markdown,.txt,.json" style="padding:.2rem"><button class="sm" id="im-dry">Dry run</button><button class="sm primary" id="im-go" disabled>Import</button><span id="im-msg" class="muted" style="font-size:12px"></span></div>
        <textarea id="im-text" placeholder="## [decision] Title&#10;&#10;Narrative paragraph.&#10;&#10;- a fact&#10;- another fact&#10;&#10;files: src/a.ts, src/b.ts&#10;pinned: yes"></textarea></div>

      <div class="section"><h2>Settings <span class="muted" style="text-transform:none;letter-spacing:0">(read-only · edit ~/.recall/settings.json)</span></h2><dl class="card" style="display:grid">${settings}</dl></div>`;

    const link = () => { $("#ex-link").href = `/api/export?project=${encodeURIComponent($("#ex-project").value)}&format=${$("#ex-format").value}`; };
    $("#ex-project").onchange = link; $("#ex-format").onchange = link; link();

    $("#im-file").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      $("#im-text").value = await f.text();
      if (f.name.endsWith(".json")) $("#im-format").value = "json";
      $("#im-go").disabled = true; $("#im-msg").textContent = "file loaded — run a dry run";
    };
    $("#im-text").oninput = () => { $("#im-go").disabled = true; $("#im-msg").textContent = ""; };
    const payload = () => ({ project_id: $("#im-project").value, format: $("#im-format").value, content: $("#im-text").value });
    $("#im-dry").onclick = async () => {
      try {
        const r = await api("/api/import", { body: { ...payload(), dryRun: true } });
        $("#im-msg").textContent = r.count ? `would import ${r.count}: ${r.titles.slice(0, 5).join(" · ")}${r.count > 5 ? " …" : ""}` : "nothing parsed — check the format";
        $("#im-go").disabled = !r.count;
      } catch (err) { oops(err); }
    };
    $("#im-go").onclick = async () => {
      try {
        const r = await api("/api/import", { body: payload() });
        toast(`Imported ${r.count} memor${r.count === 1 ? "y" : "ies"}`);
        $("#im-text").value = ""; $("#im-go").disabled = true; $("#im-msg").textContent = "";
        await refreshProjects();
        S.project = payload().project_id;
        go("all");
      } catch (err) { oops(err); }
    };
  } catch (e) { $("#hl").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
