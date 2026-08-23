// Keyboard map. Bindings are ignored while typing in a field or while a modifier other than Shift is held.
import { $, S, VIEWS, go, moveCursor, openDetail, current, toggleSelect, selectAll, clearSelection, closePane, startEdit, startCreate, togglePin, toggleArchive, bulk, deleteOpen, feedback, toggleHelp } from "./app.js";

const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
let pendingG = 0;

export function installKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e)) return;
    const k = e.key;

    if (pendingG && Date.now() - pendingG < 800) {
      pendingG = 0;
      const target = Object.entries(VIEWS).find(([, v]) => v.key === k.toLowerCase());
      if (target) { e.preventDefault(); go(target[0], { id: null }); }
      return;
    }
    pendingG = 0;

    const list = VIEWS[S.view].list;
    switch (k) {
      case "?": e.preventDefault(); toggleHelp(); return;
      case "/": e.preventDefault(); $("#q").focus(); $("#q").select(); return;
      case "n": e.preventDefault(); startCreate(); return;
      case "g": pendingG = Date.now(); return;
      case "Escape":
        e.preventDefault();
        if ($("#overlay").innerHTML) return toggleHelp();
        if (S.selected.size) return clearSelection();
        if (S.openItem) return closePane();
        return;
    }
    if (!list && !S.openItem) return;
    switch (k) {
      case "j": case "ArrowDown": e.preventDefault(); moveCursor(1); break;
      case "k": case "ArrowUp": e.preventDefault(); moveCursor(-1); break;
      case "Enter": case "o": { const c = current(); if (c) { e.preventDefault(); openDetail(c.id); } break; }
      case "x": { const c = current(); if (c) { e.preventDefault(); toggleSelect(c.id); } break; }
      case "X": e.preventDefault(); selectAll(); break;
      case "e": if (S.openItem) { e.preventDefault(); startEdit(); } else { const c = current(); if (c) { e.preventDefault(); openDetail(c.id).then(startEdit); } } break;
      case "p": e.preventDefault(); S.selected.size ? bulk(allPinned() ? "unpin" : "pin") : togglePin(S.openItem?.id || current()?.id); break;
      case "a": e.preventDefault(); S.selected.size ? bulk(allArchived() ? "unarchive" : "archive") : toggleArchive(S.openItem?.id || current()?.id); break;
      case "d": case "Delete": e.preventDefault(); S.selected.size ? bulk("delete") : deleteOpen(S.openItem?.id || current()?.id); break;
      case "m": e.preventDefault(); bulk("merge"); break;
      case "f": { const id = S.openItem?.id || current()?.id; if (id) { e.preventDefault(); feedback(id, true); } break; }
      case "F": { const id = S.openItem?.id || current()?.id; if (id) { e.preventDefault(); feedback(id, false); } break; }
    }
  });
}
const selectedItems = () => S.items.filter((o) => S.selected.has(o.id));
const allPinned = () => selectedItems().every((o) => o.pinned);
const allArchived = () => selectedItems().every((o) => o.archived);
