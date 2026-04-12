(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  const React = window.React || PluginApi.React;
  const ReactDOM = window.ReactDOM || PluginApi.ReactDOM;
  const { useState, useEffect, useRef } = React;
  const ce = React.createElement;

  const LOG = (...args) => console.log("[MRStashTranscode]", ...args);
  const WARN = (...args) => console.warn("[MRStashTranscode]", ...args);

  LOG("Plugin script loaded, Stash v0.31");

  // ── GraphQL helpers ────────────────────────────────────────────────────────

  async function gqlQuery(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  }

  async function fetchScene(sceneId) {
    const data = await gqlQuery(
      `query FindScene($id: ID!) {
        findScene(id: $id) {
          id title
          paths { screenshot }
          files { path size video_codec width height bit_rate duration }
        }
      }`,
      { id: sceneId }
    );
    return data.findScene;
  }

  async function runPluginTask(taskName, args) {
    await gqlQuery(
      `mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args: [PluginArgInput!]) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args: $args)
      }`,
      { plugin_id: "MRStashTranscode", task_name: taskName, args: args || [] }
    );
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  function sceneIdFromPath(pathname) {
    const m = pathname.match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function formatBytes(bytes) {
    if (!bytes) return "—";
    const gb = bytes / 1024 / 1024 / 1024;
    if (gb >= 1) return gb.toFixed(2) + " GB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function formatDuration(secs) {
    if (!secs) return "—";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function codecClass(codec) {
    if (!codec) return "codec-other";
    const c = codec.toLowerCase();
    if (c === "h264" || c === "avc") return "codec-h264";
    if (c === "h265" || c === "hevc") return "codec-h265";
    return "codec-other";
  }

  function codecLabel(codec) {
    if (!codec) return "Unknown";
    const c = codec.toLowerCase();
    if (c === "h264" || c === "avc") return "H.264";
    if (c === "h265" || c === "hevc") return "H.265";
    return codec.toUpperCase();
  }

  // ── Poll for dry run results ───────────────────────────────────────────────

  async function pollDryRunResults(sceneId, onResult, onProgress, onError, maxAttempts) {
    const base = `/plugin/MRStashTranscode/assets/dryrun_${sceneId}.json`;
    let attempts = 0;
    const limit = maxAttempts || 360; // 3 min at 500ms — Pi encodes are slow

    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(base + `?t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (String(data.scene_id) !== String(sceneId)) return; // stale result
          if (data.status === "done") {
            clearInterval(interval);
            onResult(data);
          } else if (data.status === "pending") {
            onProgress && onProgress(attempts);
          }
        }
        // 404 = not started yet, keep waiting
      } catch (_) {}
      if (attempts >= limit) {
        clearInterval(interval);
        onError("Timed out waiting for dry run results.");
      }
    }, 500);

    return () => clearInterval(interval);
  }

  // ── Codec Badge ────────────────────────────────────────────────────────────

  function CodecBadge({ sceneId, onTranscodeClick }) {
    const [codec, setCodec] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      LOG("CodecBadge mounted for scene", sceneId);
      fetchScene(sceneId)
        .then((scene) => {
          if (scene && scene.files && scene.files.length > 0) {
            const c = scene.files[0].video_codec || null;
            LOG("Scene", sceneId, "codec:", c);
            setCodec(c);
          } else {
            WARN("Scene", sceneId, "returned no files");
          }
        })
        .catch((e) => WARN("fetchScene error:", e))
        .finally(() => setLoading(false));
    }, [sceneId]);

    if (loading || !codec) return null;

    const cls = codecClass(codec);
    const label = codecLabel(codec);
    const isH264 = cls === "codec-h264";

    const title = isH264
      ? "Click to transcode to H.265"
      : cls === "codec-h265" ? "Already H.265" : "Codec not supported";

    return ce(
      "span",
      {
        className: `stash-transcode-badge ${cls}`,
        onClick: () => isH264 && onTranscodeClick && onTranscodeClick(sceneId),
        title,
      },
      ce("span", { className: "codec-dot" }),
      label
    );
  }

  // ── DOM diagnosis helper ───────────────────────────────────────────────────
  // Call this from the browser console: MRStashTranscode.diagnose()
  // It will log every candidate element so we can pick the right selector.

  function diagnose() {
    LOG("=== DOM Diagnosis ===");
    LOG("pathname:", window.location.pathname);

    const checks = [
      // toolbar / header candidates
      ".scene-header",
      ".scene-header h2",
      ".scene-header .scene-header-title",
      ".detail-header",
      ".detail-header h2",
      ".detail-header-title",
      "h2.scene-title",
      ".scene-toolbar-group",
      ".scene-toolbar",
      // generic heading sweep
      "h1", "h2", "h3",
    ];

    checks.forEach((sel) => {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        els.forEach((el) => {
          LOG(`  FOUND "${sel}":`, el.className, "|", el.textContent.trim().slice(0, 60));
        });
      }
    });

    LOG("=== End Diagnosis ===");
    LOG("If none of the above matched a scene title, inspect the page and find");
    LOG("the element containing the scene name, then note its class/tag.");
  }

  window.MRStashTranscode = { diagnose };

  // ── Batch Modal ────────────────────────────────────────────────────────────────

  let _batchModalRoot = null;

  function openBatchModal() {
    if (!_batchModalRoot) {
      _batchModalRoot = document.createElement("div");
      _batchModalRoot.id = "st-batch-modal-root";
      document.body.appendChild(_batchModalRoot);
    }
    ReactDOM.render(ce(BatchModal, { onClose: closeBatchModal }), _batchModalRoot);
  }

  function closeBatchModal() {
    if (_batchModalRoot && ReactDOM) ReactDOM.unmountComponentAtNode(_batchModalRoot);
  }

  function BatchModal({ onClose }) {
    // When used as a routed page, onClose navigates back
    if (!onClose) onClose = () => { window.history.back(); };
    const [crf, setCrf] = useState(28);
    const [tagName, setTagName] = useState("");
    const [scenes, setScenes] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [phase, setPhase] = useState("idle");
    const [statusMsg, setStatusMsg] = useState("");
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const cancelRef = useRef(null);

    useEffect(() => {
      gqlQuery("query { configuration { plugins } }")
        .then(d => {
          const cfg = d.configuration && d.configuration.plugins && d.configuration.plugins.MRStashTranscode;
          if (cfg && cfg.target_tag) setTagName(cfg.target_tag);
        })
        .catch(() => {});
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }, []);

    async function handleFindScenes() {
      if (!tagName.trim()) return;
      setLoading(true); setError(null); setScenes(null);
      try {
        const tagData = await gqlQuery(
          `query FindTag($name: String!) { findTags(filter: {q: $name}) { tags { id name } } }`,
          { name: tagName.trim() }
        );
        const tags = (tagData.findTags.tags || []).filter(t => t.name.toLowerCase() === tagName.trim().toLowerCase());
        if (!tags.length) { setError(`Tag "${tagName}" not found.`); setLoading(false); return; }
        const sceneData = await gqlQuery(
          `query FindScenes($tag_id: ID!) {
            findScenes(filter: {per_page: -1}, scene_filter: {tags: {value: [$tag_id], modifier: INCLUDES}}) {
              scenes { id title files { video_codec size duration } }
            }
          }`,
          { tag_id: tags[0].id }
        );
        const h264 = (sceneData.findScenes.scenes || []).filter(s =>
          s.files && s.files[0] && ["h264","avc"].includes((s.files[0].video_codec||"").toLowerCase())
        );
        setScenes(h264);
      } catch(e) { setError(e.message); }
      setLoading(false);
    }

    async function handleBatch() {
      if (!scenes || !scenes.length) return;
      setPhase("running");
      let cancelled = false;
      cancelRef.current = () => { cancelled = true; };

      for (let i = 0; i < scenes.length; i++) {
        if (cancelled) break;
        const scene = scenes[i];
        const title = scene.title || `Scene #${scene.id}`;
        setProgress({ done: i, total: scenes.length });
        setStatusMsg(`Queuing ${i+1}/${scenes.length}: ${title}`);

        try {
          await runPluginTask("Transcode Scene", [
            { key: "scene_id", value: { str: scene.id } },
            { key: "crf", value: { str: String(crf) } },
          ]);
        } catch(e) { continue; }

        // Poll for completion before moving to next scene
        await new Promise(resolve => {
          const base = `/plugin/MRStashTranscode/assets/transcode_${scene.id}.json`;
          let attempts = 0;
          const iv = setInterval(async () => {
            if (cancelled) { clearInterval(iv); resolve("cancelled"); return; }
            attempts++;
            try {
              const res = await fetch(base + `?t=${Date.now()}`);
              if (res.ok) {
                const data = await res.json();
                if (String(data.scene_id) === String(scene.id) &&
                    (data.status === "done" || data.status === "error")) {
                  clearInterval(iv); resolve(data.status); return;
                }
                // Show ffmpeg progress if available
                try {
                  const pRes = await fetch(`/plugin/MRStashTranscode/assets/progress_${scene.id}.json?t=${Date.now()}`);
                  if (pRes.ok) {
                    const p = await pRes.json();
                    const eta = p.eta_secs != null
                      ? (p.eta_secs > 60 ? `${Math.floor(p.eta_secs/60)}m ${p.eta_secs%60}s` : `${p.eta_secs}s`)
                      : "…";
                    setStatusMsg(`${i+1}/${scenes.length}: ${title} — ${p.pct||0}% ETA ${eta}`);
                  }
                } catch(_) {}
              }
            } catch(_) {}
            if (attempts > 4320) { clearInterval(iv); resolve("timeout"); }
          }, 500);
          const prev = cancelRef.current;
          cancelRef.current = () => { prev && prev(); clearInterval(iv); resolve("cancelled"); };
        });
      }

      if (cancelled) {
        setPhase("idle"); setStatusMsg("");
      } else {
        setProgress({ done: scenes.length, total: scenes.length });
        setPhase("done");
        setStatusMsg(`All ${scenes.length} scenes processed. Run a library scan to pick up new files.`);
      }
    }

    const totalSize = scenes ? scenes.reduce((a, s) => a + ((s.files&&s.files[0]&&s.files[0].size)||0), 0) : 0;
    const totalDur  = scenes ? scenes.reduce((a, s) => a + ((s.files&&s.files[0]&&s.files[0].duration)||0), 0) : 0;
    const fmtSize = b => b >= 1e9 ? (b/1e9).toFixed(1)+" GB" : (b/1e6).toFixed(0)+" MB";
    const fmtDur  = s => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; };
    const crfLabel = c => c<=20?"near-lossless":c<=24?"high quality":c<=28?"balanced":c<=32?"smaller":"aggressive";

    return ce("div", { className: "st-modal-overlay", onClick: e => { if (e.target===e.currentTarget) onClose(); } },
      ce("div", { className: "st-modal-box" },
        ce("div", { className: "st-modal-header" },
          ce("h2", null, "Batch Transcode"),
          ce("button", { className: "st-modal-close", onClick: onClose }, "✕")
        ),
        ce("div", { className: "st-subtitle" }, "Find all H.264 scenes with a tag and transcode them to H.265."),

        // CRF
        ce("div", { style: { marginBottom: 20, display: "flex", alignItems: "center", gap: 12 } },
          ce("label", { style: { fontSize: 12, color: "#888", whiteSpace: "nowrap" } }, "CRF:"),
          ce("input", { type: "range", min: 18, max: 35, value: crf,
            onChange: e => setCrf(Number(e.target.value)),
            style: { flex: 1, accentColor: "#ffb700" } }),
          ce("span", { style: { fontSize: 13, color: "#ffb700", fontWeight: 700, minWidth: 28 } }, crf),
          ce("span", { style: { fontSize: 11, color: "#555" } }, crfLabel(crf))
        ),

        // Tag input
        ce("div", { style: { marginBottom: 20 } },
          ce("label", { style: { display: "block", fontSize: 12, color: "#888", marginBottom: 6 } }, "Tag Name"),
          ce("div", { style: { display: "flex", gap: 8 } },
            ce("input", { type: "text", value: tagName,
              onChange: e => { setTagName(e.target.value); setScenes(null); },
              onKeyDown: e => e.key === "Enter" && handleFindScenes(),
              placeholder: "e.g. transcode-me",
              style: { flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 5, color: "#ddd", padding: "7px 12px", fontSize: 13 } }),
            ce("button", { className: "st-btn st-btn-secondary",
              onClick: handleFindScenes, disabled: loading || !tagName.trim() },
              loading ? "Searching…" : "Find Scenes")
          ),
          error && ce("div", { style: { color: "#f44336", fontSize: 13, marginTop: 8 } }, error)
        ),

        // Results
        scenes && scenes.length === 0 && ce("div", { className: "st-status" }, "No H.264 scenes found with that tag."),
        scenes && scenes.length > 0 && ce("div", { className: "st-dryrun-results", style: { marginBottom: 20 } },
          ce("h3", null, `${scenes.length} H.264 scene${scenes.length!==1?"s":""} found`),
          ce("div", { className: "st-dryrun-grid" },
            ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "Total Size"),
              ce("div", { className: "stat-value" }, fmtSize(totalSize)),
              ce("div", { className: "stat-sub" }, "h264 originals")
            ),
            ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "Total Duration"),
              ce("div", { className: "stat-value" }, fmtDur(totalDur))
            ),
            ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "CRF"),
              ce("div", { className: "stat-value" }, crf),
              ce("div", { className: "stat-sub" }, crfLabel(crf))
            )
          ),
          ce("div", { style: { marginTop: 12, maxHeight: 180, overflowY: "auto" } },
            scenes.map(s => ce("div", { key: s.id,
              style: { fontSize: 12, color: "#888", padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" } },
              ce("span", { style: { color: "#bbb" } }, s.title || `Scene #${s.id}`),
              " — ", s.files&&s.files[0] ? fmtSize(s.files[0].size) : "?"
            ))
          )
        ),

        // Progress
        phase === "running" && ce("div", { style: { marginBottom: 16 } },
          ce("div", { className: "st-status running" }, statusMsg),
          ce("div", { className: "st-progress-bar-wrap" },
            ce("div", { className: "st-progress-bar", style: {
              width: progress.total > 0 ? Math.max(2, progress.done/progress.total*100)+"%" : "2%"
            }})
          ),
          ce("div", { style: { fontSize: 11, color: "#555", marginTop: 4 } }, `${progress.done} of ${progress.total} complete`)
        ),
        phase === "done" && ce("div", { className: "st-status success", style: { marginBottom: 16 } }, statusMsg),

        // Actions
        ce("div", { className: "st-actions" },
          phase === "idle" && scenes && scenes.length > 0 &&
            ce("button", { className: "st-btn st-btn-primary", onClick: handleBatch },
              `Transcode ${scenes.length} Scene${scenes.length!==1?"s":""}`),
          phase === "running" &&
            ce("button", { className: "st-btn st-btn-secondary", onClick: () => cancelRef.current && cancelRef.current() },
              "Cancel (finishes current scene)"),
          phase === "done" &&
            ce("button", { className: "st-btn st-btn-secondary", onClick: onClose }, "Close")
        )
      )
    );
  }

  // ── Register batch tool route (same approach as DupFileManager) ─────────────

  // Inject a floating "Batch" button into the navbar via DOM
  // (PluginApi.patch on MainNavBar causes React/intl context errors in v0.31)
  function injectNavButton() {
    if (document.getElementById("st-nav-btn")) return;

    // Log navbar structure on first run so we can find the right selector
    const navbar = document.querySelector(".navbar") || document.querySelector("nav");
    if (!navbar) { LOG("No navbar found"); return; }


    // Target the right-side button group
    const target =
      navbar.querySelector(".navbar-buttons") ||
      navbar.querySelector(".ml-auto.navbar-nav") ||
      navbar.querySelector(".navbar-nav:last-child") ||
      navbar;

    LOG("Right side target:", target.className);

    const btn = document.createElement("button");
    btn.id = "st-nav-btn";
    btn.title = "Batch Transcode H.264 → H.265";
    // SVG icon: two arrows forming a cycle (transcode symbol)
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"></polyline>
      <polyline points="1 20 1 14 7 14"></polyline>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
    </svg>`;
    btn.style.cssText = [
      "background:transparent", "border:none",
      "color:#aaa", "cursor:pointer",
      "padding:6px", "display:inline-flex",
      "align-items:center", "justify-content:center",
      "border-radius:4px", "line-height:1",
    ].join(";");
    btn.addEventListener("click", openBatchModal);
    btn.addEventListener("mouseenter", () => { btn.style.color = "#ffb700"; });
    btn.addEventListener("mouseleave", () => { btn.style.color = "#aaa"; });
    // Insert at the start of the right-side group
    target.insertBefore(btn, target.firstChild);
    LOG("Nav batch button injected into:", target.className);
  }

  // Inject on load and after navigation
  setTimeout(injectNavButton, 800);
  PluginApi.Event.addEventListener("stash:location", () => setTimeout(injectNavButton, 300));

  function BatchToolEntry() {
    return ce("div", { style: { marginTop: 24, paddingTop: 24, borderTop: "1px solid rgba(255,255,255,0.08)" } },
      ce("h3", { style: { fontSize: 16, fontWeight: 600, color: "#eee", marginBottom: 4 } }, "MRStashTranscode"),
      ce("p", { style: { fontSize: 13, color: "#777", marginBottom: 12 } },
        "Transcode H.264 scenes to H.265 in bulk. Set your target tag in Settings → Plugins → MRStashTranscode."
      ),
      ce("button", { className: "st-btn st-btn-primary", onClick: openBatchModal }, "Open Batch Transcode")
    );
  }

  // ── DOM-injection ──────────────────────────────────────────────────────────
  // Priority-ordered selectors. We'll log which one (if any) matched.

  const BADGE_SELECTORS = [
    ".scene-header h2",
    ".scene-header .scene-header-title",
    ".detail-header h2",
    ".detail-header-title",
    "h2.scene-title",
    // toolbar fallback — inserts after the existing buttons
    ".scene-toolbar-group",
  ];

  function injectBadge(sceneId) {
    LOG("injectBadge: waiting for DOM target, sceneId =", sceneId);
    let attempts = 0;

    const iv = setInterval(() => {
      attempts++;

      let target = null;
      let matchedSel = null;
      for (const sel of BADGE_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) { target = el; matchedSel = sel; break; }
      }

      if (!target) {
        if (attempts === 30) {
          // Give up and log diagnosis so the user can see what IS in the DOM
          WARN("injectBadge: no selector matched after 3s. Running diagnosis…");
          diagnose();
          clearInterval(iv);
        }
        return;
      }

      clearInterval(iv);
      LOG("injectBadge: matched selector", matchedSel, "on attempt", attempts);

      if (target.querySelector(".stash-transcode-badge-mount")) {
        LOG("injectBadge: badge already mounted, skipping");
        return;
      }

      const mount = document.createElement("span");
      mount.className = "stash-transcode-badge-mount";
      target.appendChild(mount);
      LOG("injectBadge: mount point created, rendering CodecBadge");

      ReactDOM.render(
        ce(CodecBadge, { sceneId, onTranscodeClick: openToolModal }),
        mount
      );
    }, 100);
  }

  let _lastInjectedSceneId = null;

  function maybeInjectBadge() {
    const sceneId = sceneIdFromPath(window.location.pathname);
    LOG("maybeInjectBadge: pathname =", window.location.pathname, "sceneId =", sceneId);

    if (!sceneId) return;
    if (sceneId === _lastInjectedSceneId) {
      return; // same scene, already injected
    }
    _lastInjectedSceneId = sceneId;

    document.querySelectorAll(".stash-transcode-badge-mount").forEach((el) => {
      if (ReactDOM) ReactDOM.unmountComponentAtNode(el);
      el.remove();
    });

    injectBadge(sceneId);
  }

  PluginApi.Event.addEventListener("stash:location", () => {
    LOG("stash:location event fired");
    // Small delay to let React render the new page content
    setTimeout(maybeInjectBadge, 100);
  });

  // Poll briefly on initial load in case stash:location doesn't fire
  let _initChecks = 0;
  const _initInterval = setInterval(() => {
    _initChecks++;
    const sceneId = sceneIdFromPath(window.location.pathname);
    if (sceneId) {
      maybeInjectBadge();
      clearInterval(_initInterval); // found a scene, stop polling
    } else if (_initChecks >= 20) {
      clearInterval(_initInterval); // not a scene page, give up
    }
  }, 100);

  // ── Tool Modal ─────────────────────────────────────────────────────────────

  let _modalRoot = null;

  function openToolModal(sceneId) {
    LOG("openToolModal for scene", sceneId);
    if (!_modalRoot) {
      _modalRoot = document.createElement("div");
      _modalRoot.id = "st-modal-root";
      document.body.appendChild(_modalRoot);
    }
    ReactDOM.render(
      ce(TranscodeModal, { sceneId: String(sceneId), onClose: closeToolModal }),
      _modalRoot
    );
  }

  function closeToolModal() {
    if (_modalRoot && ReactDOM) ReactDOM.unmountComponentAtNode(_modalRoot);
  }

  // ── TranscodeModal ─────────────────────────────────────────────────────────

  function TranscodeModal({ sceneId: initId, onClose }) {
    const [sceneIdInput, setSceneIdInput] = useState(initId || "");
    const [scene, setScene] = useState(null);
    const [sceneError, setSceneError] = useState(null);
    const [loadingScene, setLoadingScene] = useState(false);
    const [crf, setCrf] = useState(28);
    const [phase, setPhase] = useState("idle");
    const [transcodeProgress, setTranscodeProgress] = useState(0);
    const [dryRunResults, setDryRunResults] = useState(null);
    const [statusMsg, setStatusMsg] = useState("");
    const cancelRef = useRef(null);

    useEffect(() => {
      if (initId) loadScene(initId);
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }, []);

    function loadScene(id) {
      setLoadingScene(true);
      setSceneError(null);
      setScene(null);
      setPhase("idle");
      setDryRunResults(null);
      fetchScene(id)
        .then((s) => { if (!s) setSceneError(`No scene #${id}`); else setScene(s); })
        .catch((e) => setSceneError(e.message))
        .finally(() => setLoadingScene(false));
    }

    async function handleDryRun() {
      if (!scene) return;
      if (cancelRef.current) cancelRef.current();
      setPhase("dryrun-running");
      setStatusMsg("Encoding 30-second sample…");
      setDryRunResults(null);
      try {
        await runPluginTask("Dry Run", [
          { key: "scene_id", value: { str: scene.id } },
          { key: "crf", value: { str: String(crf) } },
        ]);
      } catch (e) {
        setPhase("error");
        setStatusMsg("Failed to start dry run: " + e.message);
        return;
      }
      const cancel = await pollDryRunResults(
        scene.id,
        (data) => { setDryRunResults(data); setPhase("dryrun-done"); setStatusMsg(""); },
        (attempts) => { setStatusMsg(`Encoding sample… (${Math.round(attempts / 2)}s)`); },
        (err) => { setPhase("error"); setStatusMsg(err); }
      );
      cancelRef.current = cancel;
    }

    async function handleTranscode() {
      if (!scene) return;
      setPhase("transcoding");
      setStatusMsg("Transcode queued…");

      try {
        await runPluginTask("Transcode Scene", [
          { key: "scene_id", value: { str: scene.id } },
          { key: "crf", value: { str: String(crf) } },
        ]);
      } catch (e) {
        setPhase("error");
        setStatusMsg("Failed to queue: " + e.message);
        return;
      }

      // Poll transcode_{sceneId}.json for completion
      const base = `/plugin/MRStashTranscode/assets/transcode_${scene.id}.json`;
      let attempts = 0;
      const limit = 2160; // 18 min at 500ms
      const iv = setInterval(async () => {
        attempts++;
        const elapsed = Math.round(attempts / 2);
        try {
          const res = await fetch(base + `?t=${Date.now()}`);
          if (res.ok) {
            const data = await res.json();
            if (String(data.scene_id) === String(scene.id)) {
              if (data.status === "done") {
                clearInterval(iv);
                const mb = data.output_size ? (data.output_size / 1024 / 1024).toFixed(1) + " MB" : "";
                setPhase("done");
                setStatusMsg(`Done in ${data.elapsed}s${mb ? " — " + mb : ""}. Run a library scan to pick up the new file.`);
              } else if (data.status === "error") {
                clearInterval(iv);
                setPhase("error");
                setStatusMsg("Transcode failed. Check Stash task logs.");
              } else if (data.status === "running") {
                // Also fetch progress file for detailed stats
                try {
                  const pRes = await fetch(`/plugin/MRStashTranscode/assets/progress_${scene.id}.json?t=${Date.now()}`);
                  if (pRes.ok) {
                    const p = await pRes.json();
                    const pct = p.pct || 0;
                    const eta = p.eta_secs != null ? (p.eta_secs > 60
                      ? `${Math.floor(p.eta_secs / 60)}m ${p.eta_secs % 60}s`
                      : `${p.eta_secs}s`) : "…";
                    const speed = p.speed ? `${parseFloat(p.speed).toFixed(2)}x` : "";
                    setStatusMsg(`Transcoding ${pct}% — ETA ${eta}${speed ? " @ " + speed : ""}`);
                    setTranscodeProgress(pct);
                  } else {
                    setStatusMsg(`Transcoding… ${elapsed}s elapsed`);
                  }
                } catch (_) {
                  setStatusMsg(`Transcoding… ${elapsed}s elapsed`);
                }
              }
            }
          } else {
            // 404 = task queued, not started yet
            setStatusMsg(`Waiting for task to start… ${elapsed}s`);
          }
        } catch (_) {}
        if (attempts >= limit) {
          clearInterval(iv);
          setPhase("error");
          setStatusMsg("Timed out waiting for transcode to complete.");
        }
      }, 500);

      if (cancelRef.current) cancelRef.current();
      cancelRef.current = () => clearInterval(iv);
    }

    function handleReset() {
      if (cancelRef.current) cancelRef.current();
      setPhase("idle"); setStatusMsg(""); setDryRunResults(null); setTranscodeProgress(0);
    }

    const file = scene && scene.files && scene.files[0];
    const codec = file && file.video_codec ? file.video_codec.toLowerCase() : "";
    const isH264 = codec === "h264" || codec === "avc";

    return ce("div", {
      className: "st-modal-overlay",
      onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
    },
      ce("div", { className: "st-modal-box" },
        ce("div", { className: "st-modal-header" },
          ce("h2", null, "MRStashTranscode"),
          ce("button", { className: "st-modal-close", onClick: onClose }, "✕")
        ),
        ce("div", { className: "st-subtitle" }, "Transcode H.264 → H.265. Run a dry run first."),

        // CRF slider
        ce("div", { style: { marginBottom: 20, display: "flex", alignItems: "center", gap: 12 } },
          ce("label", { style: { fontSize: 12, color: "#888", whiteSpace: "nowrap" } }, "CRF (quality):"),
          ce("input", {
            type: "range", min: 18, max: 35, value: crf,
            onChange: (e) => { setCrf(Number(e.target.value)); setDryRunResults(null); setPhase("idle"); },
            style: { flex: 1, accentColor: "#ffb700" },
          }),
          ce("span", { style: { fontSize: 13, color: "#ffb700", fontWeight: 700, minWidth: 28, textAlign: "right" } }, crf),
          ce("span", { style: { fontSize: 11, color: "#555", whiteSpace: "nowrap" } },
            crf <= 20 ? "near-lossless" : crf <= 24 ? "high quality" : crf <= 28 ? "balanced" : crf <= 32 ? "smaller file" : "aggressive"
          )
        ),

        ce("div", { style: { marginBottom: 20 } },
          ce("label", { style: { display: "block", fontSize: 12, color: "#888", marginBottom: 6 } }, "Scene ID"),
          ce("div", { style: { display: "flex", gap: 8 } },
            ce("input", {
              type: "text", value: sceneIdInput,
              onChange: (e) => setSceneIdInput(e.target.value),
              onKeyDown: (e) => e.key === "Enter" && loadScene(sceneIdInput.trim()),
              placeholder: "e.g. 42",
              style: {
                background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 5, color: "#ddd", padding: "7px 12px", fontSize: 13, width: 140,
              },
            }),
            ce("button", {
              className: "st-btn st-btn-secondary",
              onClick: () => loadScene(sceneIdInput.trim()),
              disabled: loadingScene,
            }, loadingScene ? "Loading…" : "Load Scene")
          ),
          sceneError && ce("div", { style: { color: "#f44336", fontSize: 13, marginTop: 8 } }, sceneError)
        ),

        scene && ce("div", { className: "st-scene-card" },
          scene.paths && scene.paths.screenshot ? ce("img", { src: scene.paths.screenshot, alt: "" }) : null,
          ce("div", { className: "st-scene-info" },
            ce("div", { className: "st-scene-title" }, scene.title || `Scene #${scene.id}`),
            ce("div", { className: "st-scene-meta" },
              file && ce("div", { className: "st-meta-item" }, "Codec: ", ce("span", null, codecLabel(file.video_codec))),
              file && ce("div", { className: "st-meta-item" }, "Res: ", ce("span", null, `${file.width}×${file.height}`)),
              file && ce("div", { className: "st-meta-item" }, "Size: ", ce("span", null, formatBytes(file.size))),
              file && ce("div", { className: "st-meta-item" }, "Duration: ", ce("span", null, formatDuration(file.duration)))
            )
          )
        ),

        phase === "error" && statusMsg
          ? ce("div", { className: "st-status error", style: { marginBottom: 16 } }, statusMsg) : null,

        dryRunResults && ce("div", { className: "st-dryrun-results" },
          ce("h3", null, "Dry Run Estimate"),
          ce("div", { className: "st-dryrun-grid" },
            ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "Original"),
              ce("div", { className: "stat-value" }, formatBytes(dryRunResults.original_size)),
              ce("div", { className: "stat-sub" }, dryRunResults.original_codec || "h264")
            ),
            ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "Estimated"),
              ce("div", { className: "stat-value" }, formatBytes(dryRunResults.estimated_size)),
              ce("div", { className: "stat-sub" }, `h265 @ CRF ${dryRunResults.crf || crf}`)
            ),
            ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "Savings"),
              ce("div", { className: `stat-value ${dryRunResults.saving_percent < 0 ? "st-larger" : "st-saving"}` },
                (dryRunResults.saving_percent < 0 ? "+" : "-") + Math.abs(dryRunResults.saving_percent).toFixed(1) + "%"
              ),
              ce("div", { className: "stat-sub" }, dryRunResults.saving_percent < 0 ? "larger" : "smaller")
            ),
            dryRunResults.sample_encode_time && ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "Sample Time"),
              ce("div", { className: "stat-value" }, dryRunResults.sample_encode_time + "s"),
              ce("div", { className: "stat-sub" }, "30s sample")
            ),
            dryRunResults.src_kbps && ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "Source Bitrate"),
              ce("div", { className: "stat-value" }, Math.round(dryRunResults.src_kbps / 1000) + " Mbps"),
              ce("div", { className: "stat-sub" }, "h264 video track")
            ),
            dryRunResults.out_kbps && ce("div", { className: "st-dryrun-stat" },
              ce("div", { className: "stat-label" }, "Output Bitrate"),
              ce("div", { className: "stat-value" }, Math.round(dryRunResults.out_kbps / 1000) + " Mbps"),
              ce("div", { className: "stat-sub" }, `h265 CRF ${dryRunResults.crf || crf}`)
            )
          ),
          dryRunResults.before_thumb && dryRunResults.after_thumb && ce(React.Fragment, null,
            ce("div", { className: "st-compare", style: { marginTop: 16 } },
              ce("div", { className: "st-compare-panel panel-before" },
                ce("div", { className: "st-compare-label" }, "H.264 — Original"),
                ce("img", {
                  src: `/plugin/MRStashTranscode/assets/${dryRunResults.before_thumb}?t=${Date.now()}`,
                  alt: "before",
                  style: { cursor: "pointer" },
                  onClick: (e) => e.target.requestFullscreen && e.target.requestFullscreen(),
                })
              ),
              ce("div", { className: "st-compare-panel panel-after" },
                ce("div", { className: "st-compare-label" }, "H.265 — Sample"),
                ce("img", {
                  src: `/plugin/MRStashTranscode/assets/${dryRunResults.after_thumb}?t=${Date.now()}`,
                  alt: "after",
                  style: { cursor: "pointer" },
                  onClick: (e) => e.target.requestFullscreen && e.target.requestFullscreen(),
                })
              )
            ),
            ce("div", { style: { fontSize: 11, color: "#555", marginTop: 8, lineHeight: 1.5 } },
              "Click either image to fullscreen. ",
              (() => {
                const c = dryRunResults.crf || crf;
                if (c <= 20) return "CRF " + c + " — near-lossless, virtually no quality loss.";
                if (c <= 24) return "CRF " + c + " — high quality, transparent to most viewers.";
                if (c <= 28) return "CRF " + c + " — good quality, minor loss in fast motion or fine grain.";
                if (c <= 32) return "CRF " + c + " — noticeable on large/VR screens, especially dark scenes.";
                return "CRF " + c + " — aggressive compression, visible softness likely on a VR headset.";
              })()
            )
          )
        ),

        scene && (() => {
          if (!isH264) return ce("div", { className: "st-status" }, `This scene is ${codecLabel(codec)} — only H.264 can be transcoded.`);
          if (phase === "idle" || phase === "error") return ce("div", { className: "st-actions" },
            ce("button", { className: "st-btn st-btn-primary", onClick: handleDryRun }, "Dry Run")
          );
          if (phase === "dryrun-running") return ce("div", null,
            ce("div", { className: "st-status running" }, statusMsg),
            ce("div", { className: "st-progress-bar-wrap" }, ce("div", { className: "st-progress-bar", style: { width: "40%" } })),
            ce("div", { className: "st-actions", style: { marginTop: 8 } },
              ce("button", { className: "st-btn st-btn-secondary", onClick: handleReset }, "Cancel")
            )
          );
          if (phase === "dryrun-done") return ce("div", { className: "st-actions" },
            ce("button", { className: "st-btn st-btn-primary", onClick: handleTranscode }, "Transcode Now"),
            ce("button", { className: "st-btn st-btn-secondary", onClick: handleDryRun }, "Re-run"),
            ce("button", { className: "st-btn st-btn-danger", onClick: handleReset }, "Cancel")
          );
          if (phase === "transcoding") return ce("div", null,
            ce("div", { className: "st-status running" }, statusMsg),
            ce("div", { className: "st-progress-bar-wrap" },
              ce("div", { className: "st-progress-bar", style: { width: (transcodeProgress || 2) + "%" } })
            ),
            ce("div", { className: "st-actions", style: { marginTop: 8 } },
              ce("button", { className: "st-btn st-btn-secondary", onClick: handleReset }, "Hide (task continues in background)")
            )
          );
          if (phase === "done") return ce("div", null,
            ce("div", { className: "st-status success" }, statusMsg),
            ce("div", { className: "st-actions", style: { marginTop: 12 } },
              ce("button", { className: "st-btn st-btn-secondary", onClick: handleReset }, "Transcode Another")
            )
          );
          return null;
        })()
      )
    );
  }
})();