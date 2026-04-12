(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  const React = window.React || PluginApi.React;
  const ReactDOM = window.ReactDOM || PluginApi.ReactDOM;
  const { useState, useEffect } = React;
  const ce = React.createElement;

  const LOG = (...a) => console.log("[MRStashVRTagger]", ...a);

  // ── GraphQL ────────────────────────────────────────────────────────────────

  async function gql(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  }

  async function applyTagChange(sceneId, tagId, action) {
    // Fetch current tags, modify, send update
    const data = await gql(
      `query($id: ID!) { findScene(id: $id) { id tags { id } } }`,
      { id: sceneId }
    );
    const current = (data.findScene.tags || []).map(t => t.id);
    let next;
    if (action === "add") {
      if (current.includes(tagId)) return;
      next = [...current, tagId];
    } else {
      next = current.filter(id => id !== tagId);
    }
    await gql(
      `mutation($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) { id }
      }`,
      { input: { id: sceneId, tag_ids: next } }
    );
  }

  async function runAuditTask() {
    await gql(
      `mutation RunPluginTask($plugin_id: ID!, $task_name: String!) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name)
      }`,
      { plugin_id: "MRStashVRTagger", task_name: "Audit VR Tags" }
    );
  }

  // ── Audit fetch ────────────────────────────────────────────────────────────

  async function fetchAudit() {
    try {
      const res = await fetch(`/plugin/MRStashVRTagger/assets/audit.json?t=${Date.now()}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  let _modalRoot = null;

  function openModal() {
    if (!_modalRoot) {
      _modalRoot = document.createElement("div");
      _modalRoot.id = "vra-modal-root";
      document.body.appendChild(_modalRoot);
    }
    ReactDOM.render(ce(AuditModal, { onClose: closeModal }), _modalRoot);
  }

  function closeModal() {
    if (_modalRoot && ReactDOM) ReactDOM.unmountComponentAtNode(_modalRoot);
  }

  function AuditModal({ onClose }) {
    const [audit, setAudit] = useState(null);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState("all");
    const [busyIds, setBusyIds] = useState({});
    const [doneIds, setDoneIds] = useState({});
    const [running, setRunning] = useState(false);

    useEffect(() => {
      document.body.style.overflow = "hidden";
      fetchAudit().then(d => { setAudit(d); setLoading(false); });
      return () => { document.body.style.overflow = ""; };
    }, []);

    async function reRun() {
      setRunning(true);
      try { await runAuditTask(); } catch (_) {}
      // Poll for new audit.json (look for a newer generated_at)
      const oldStamp = audit && audit.generated_at;
      let attempts = 0;
      const iv = setInterval(async () => {
        attempts++;
        const fresh = await fetchAudit();
        if (fresh && fresh.generated_at && fresh.generated_at !== oldStamp) {
          clearInterval(iv);
          setAudit(fresh);
          setRunning(false);
          setDoneIds({});
        }
        if (attempts > 600) { clearInterval(iv); setRunning(false); }
      }, 1000);
    }

    async function applyOne(entry) {
      if (!audit || !audit.tag_id) return;
      setBusyIds(b => ({ ...b, [entry.id]: true }));
      try {
        await applyTagChange(entry.id, audit.tag_id, entry.action);
        setDoneIds(d => ({ ...d, [entry.id]: true }));
      } catch (e) {
        LOG("apply failed", e);
      } finally {
        setBusyIds(b => { const n = { ...b }; delete n[entry.id]; return n; });
      }
    }

    async function applyAll(list) {
      for (const entry of list) {
        if (doneIds[entry.id]) continue;
        await applyOne(entry);
      }
    }

    const all = audit ? [...audit.needs_add, ...audit.needs_remove] : [];
    const visible = filter === "add" ? (audit ? audit.needs_add : [])
                   : filter === "remove" ? (audit ? audit.needs_remove : [])
                   : all;

    return ce("div", {
      className: "vra-modal-overlay",
      onClick: e => { if (e.target === e.currentTarget) onClose(); }
    },
      ce("div", { className: "vra-modal-box" },
        ce("div", { className: "vra-modal-header" },
          ce("h2", null, "VR Tag Audit"),
          ce("button", { className: "vra-modal-close", onClick: onClose }, "✕")
        ),

        loading && ce("div", { className: "vra-status" }, "Loading audit results…"),

        !loading && !audit && ce("div", null,
          ce("div", { className: "vra-status" }, "No audit results yet. Run the audit task to generate one."),
          ce("div", { className: "vra-actions" },
            ce("button", { className: "vra-btn vra-btn-primary", onClick: reRun, disabled: running },
              running ? "Running…" : "Run Audit Now")
          )
        ),

        audit && ce(React.Fragment, null,
          ce("div", { className: "vra-subtitle" },
            `Scanned ${audit.total_scenes} scenes — threshold ${audit.threshold}:1 — tag "${audit.tag_name}"`
          ),
          !audit.tag_id && ce("div", { className: "vra-warn" },
            `Tag "${audit.tag_name}" doesn't exist yet. Create it in Stash before applying changes.`
          ),

          ce("div", { className: "vra-filter-bar" },
            ce("button", {
              className: `vra-pill ${filter==="all"?"active":""}`,
              onClick: () => setFilter("all")
            }, `All (${all.length})`),
            ce("button", {
              className: `vra-pill add ${filter==="add"?"active":""}`,
              onClick: () => setFilter("add")
            }, `Add VR (${audit.needs_add.length})`),
            ce("button", {
              className: `vra-pill remove ${filter==="remove"?"active":""}`,
              onClick: () => setFilter("remove")
            }, `Remove VR (${audit.needs_remove.length})`)
          ),

          visible.length === 0 && ce("div", { className: "vra-status" }, "Nothing to show in this category. ✓"),

          ce("div", { className: "vra-list" },
            visible.map(entry => ce("div", {
              key: entry.id,
              className: `vra-row ${doneIds[entry.id] ? "done" : ""}`
            },
              entry.screenshot
                ? ce("img", { src: entry.screenshot, alt: "" })
                : ce("div", { className: "vra-noimg" }),
              ce("div", { className: "vra-row-info" },
                ce("a", {
                  href: `/scenes/${entry.id}`,
                  target: "_blank",
                  className: "vra-row-title"
                }, entry.title),
                ce("div", { className: "vra-row-meta" },
                  `${entry.width}×${entry.height}`,
                  ce("span", { className: "vra-ratio" }, ` (${entry.ratio.toFixed(2)}:1)`)
                )
              ),
              ce("span", {
                className: `vra-action-badge ${entry.action}`
              }, entry.action === "add" ? "+ ADD VR" : "− REMOVE VR"),
              ce("button", {
                className: "vra-btn vra-btn-small",
                disabled: !audit.tag_id || busyIds[entry.id] || doneIds[entry.id],
                onClick: () => applyOne(entry)
              }, doneIds[entry.id] ? "✓ Done" : busyIds[entry.id] ? "…" : "Apply")
            ))
          ),

          ce("div", { className: "vra-actions" },
            visible.length > 0 && ce("button", {
              className: "vra-btn vra-btn-primary",
              disabled: !audit.tag_id,
              onClick: () => applyAll(visible)
            }, `Apply All (${visible.length})`),
            ce("button", {
              className: "vra-btn vra-btn-secondary",
              onClick: reRun, disabled: running
            }, running ? "Re-running…" : "Re-run Audit"),
            ce("button", { className: "vra-btn vra-btn-secondary", onClick: onClose }, "Close")
          )
        )
      )
    );
  }

  // ── Navbar icon ────────────────────────────────────────────────────────────

  async function injectNavButton() {
  const navbar = document.querySelector(".navbar") || document.querySelector("nav");
  if (!navbar) return;

  const target =
    navbar.querySelector(".navbar-buttons") ||
    navbar.querySelector(".ml-auto.navbar-nav") ||
    navbar.querySelector(".navbar-nav:last-child") ||
    navbar;

  // If our button is already inside THIS target, we're done.
  // (getElementById alone isn't enough — the old button may be orphaned
  //  in a detached node after a React re-render.)
  if (target.querySelector("#vra-nav-btn")) return;

  // Clean up any orphaned/stale instances elsewhere in the document
  document.querySelectorAll("#vra-nav-btn").forEach(el => el.remove());

  // Only show the icon if there's an audit available
  const audit = await fetchAudit();
  if (!audit) return;

  const total = audit.needs_add.length + audit.needs_remove.length;

  const btn = document.createElement("button");
  btn.id = "vra-nav-btn";
  btn.title = `VR Audit: ${total} scene${total !== 1 ? "s" : ""} need attention`;
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="7" width="20" height="11" rx="3"></rect>
    <circle cx="8" cy="12.5" r="2"></circle>
    <circle cx="16" cy="12.5" r="2"></circle>
  </svg>${total > 0 ? `<span class="vra-badge-count">${total}</span>` : ""}`;
  btn.style.cssText = [
    "background:transparent","border:none","color:#aaa","cursor:pointer",
    "padding:6px","display:inline-flex","align-items:center",
    "justify-content:center","border-radius:4px","line-height:1",
    "position:relative",
  ].join(";");
  btn.addEventListener("click", openModal);
  btn.addEventListener("mouseenter", () => { btn.style.color = "#4fc3f7"; });
  btn.addEventListener("mouseleave", () => { btn.style.color = "#aaa"; });

  // prepend() is the safe modern equivalent of insertBefore(x, firstChild)
  // and won't throw if the target's children change underneath us.
  try {
    target.prepend(btn);
    LOG("Nav button injected into:", target.className);
  } catch (e) {
    LOG("Nav button inject failed:", e);
  }
}


)();