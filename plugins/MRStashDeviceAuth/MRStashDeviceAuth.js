/**
 * MRStashDeviceAuth — MRStashDeviceAuth.js  v0.7.0
 *
 * Changelog v0.7.0
 * ----------------
 * - Navbar icon shows a red count badge for pending pairing requests plus
 *   pending headset actions (polled from /summary every 5s).
 * - Modal gains a "Pending Actions" tab: review headset delete requests,
 *   select some/all, approve or deny, optionally deleting files from disk.
 *
 * Injected into Stash's web UI by the plugin system.
 *
 * Changelog v0.6.0
 * ----------------
 * - Device management UI is now an in-SPA React modal rather than an
 *   external HTML page on port 9997. All admin calls ride on a shared
 *   secret (X-Admin-Secret) that is only retrievable via an authenticated
 *   Stash session (/plugin/MRStashDeviceAuth/assets/admin_secret.json).
 * - The navbar icon is now a <button> that opens the modal. No more
 *   target="_blank" to the sidecar's own port.
 * - Self-healing health-check and "Start Sidecar" task triggering are
 *   unchanged.
 */

(function () {
    "use strict";

    const PLUGIN_ID            = "MRStashDeviceAuth";
    const PLUGIN_NAME          = "MRStashDeviceAuth"; // for asset paths
    const DEFAULT_SIDECAR_PORT = 9997;
    let   SIDECAR_BASE         = `http://${window.location.hostname}:${DEFAULT_SIDECAR_PORT}`;
    const HEALTH_INTERVAL_MS   = 15_000;
    const TASK_NAME            = "Start Sidecar";
    const GQL_URL              = "/graphql";

    // React handles (match the pattern StashTranscode uses)
    const PluginApi = window.PluginApi;
    const React     = window.React   || (PluginApi && PluginApi.React);
    const ReactDOM  = window.ReactDOM || (PluginApi && PluginApi.ReactDOM);
    const ce        = React ? React.createElement : null;

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    async function gql(query, variables = {}) {
        const res = await fetch(GQL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables }),
        });
        if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
        return res.json();
    }

    const sidecar = (path, opts = {}) => fetch(`${SIDECAR_BASE}${path}`, opts);

    /** Read sidecar_port from Stash plugin settings and rebuild SIDECAR_BASE. */
    async function loadPort() {
        try {
            const data      = await gql(`query { configuration { plugins } }`);
            const pluginCfg = data?.data?.configuration?.plugins;
            const settings  = pluginCfg?.[PLUGIN_ID] || pluginCfg?.[PLUGIN_NAME] || {};
            const port      = parseInt(settings?.sidecar_port, 10);
            if (port && port > 0 && port < 65536) {
                SIDECAR_BASE = `http://${window.location.hostname}:${port}`;
                console.info(`[${PLUGIN_ID}] Sidecar base URL: ${SIDECAR_BASE}`);
            }
        } catch (err) {
            console.warn(`[${PLUGIN_ID}] Could not read port setting:`, err);
        }
    }

    // -------------------------------------------------------------------------
    // Admin secret — fetched from a plugin asset path that is gated by
    // Stash's own auth. Unauthenticated LAN users can't read it.
    // -------------------------------------------------------------------------

    let ADMIN_SECRET = null;

    async function loadAdminSecret() {
        try {
            const res = await fetch(
                `/plugin/${PLUGIN_NAME}/assets/admin_secret.json?t=${Date.now()}`
            );
            if (res.ok) {
                const data = await res.json();
                ADMIN_SECRET = data?.secret || null;
            } else {
                console.warn(`[${PLUGIN_ID}] admin_secret.json HTTP ${res.status}`);
            }
        } catch (err) {
            console.warn(`[${PLUGIN_ID}] Could not load admin secret:`, err);
        }
    }

    /**
     * Fetch against the sidecar with the admin secret attached.
     * If the sidecar returns 401, reload the secret once and retry — handles
     * the case where the secret file was regenerated.
     */
    async function sidecarAdmin(path, opts = {}) {
        const buildHeaders = () => {
            const h = { ...(opts.headers || {}) };
            h["X-Admin-Secret"] = ADMIN_SECRET || "";
            if (opts.body && !h["Content-Type"]) {
                h["Content-Type"] = "application/json";
            }
            return h;
        };

        let res = await fetch(`${SIDECAR_BASE}${path}`, { ...opts, headers: buildHeaders() });
        if (res.status === 401) {
            await loadAdminSecret();
            res = await fetch(`${SIDECAR_BASE}${path}`, { ...opts, headers: buildHeaders() });
        }
        return res;
    }

    // -------------------------------------------------------------------------
    // Self-healing health check
    // -------------------------------------------------------------------------

    let sidecarRunning      = false;
    let startInFlight       = false;
    let triggerBackoffUntil = 0;

    async function checkHealth() {
        try {
            const res = await sidecar("/health", { signal: AbortSignal.timeout(2000) });
            sidecarRunning = res.ok;
        } catch {
            sidecarRunning = false;
        }

        if (!sidecarRunning && !startInFlight && Date.now() > triggerBackoffUntil) {
            console.info(`[${PLUGIN_ID}] Sidecar offline — triggering "${TASK_NAME}"`);
            triggerSidecarTask();
        }

        // If sidecar came back, make sure we have a fresh secret
        if (sidecarRunning && !ADMIN_SECRET) {
            loadAdminSecret();
        }

        updateNavIcon();
    }

    async function triggerSidecarTask() {
        startInFlight = true;
        try {
            const data    = await gql(`query { plugins { id tasks { name } } }`);
            const plugins = data?.data?.plugins ?? [];
            const plugin  =
                plugins.find((p) => p.id === PLUGIN_ID) ||
                plugins.find((p) => p.name === PLUGIN_NAME);

            if (!plugin) {
                console.warn(`[${PLUGIN_ID}] Plugin not found.`);
                triggerBackoffUntil = Date.now() + 60_000;
                return;
            }
            if (!plugin.tasks?.some((t) => t.name === TASK_NAME)) {
                console.warn(`[${PLUGIN_ID}] Task "${TASK_NAME}" not found.`);
                triggerBackoffUntil = Date.now() + 60_000;
                return;
            }
            await gql(
                `mutation Run($pid: ID!, $task: String!) {
                   runPluginTask(plugin_id: $pid, task_name: $task)
                 }`,
                { pid: plugin.id, task: TASK_NAME }
            );
            console.info(`[${PLUGIN_ID}] "${TASK_NAME}" triggered.`);
            setTimeout(async () => {
                startInFlight = false;
                await checkHealth();
                await loadAdminSecret();
            }, 5000);
        } catch (err) {
            console.error(`[${PLUGIN_ID}] Failed to trigger task:`, err);
            triggerBackoffUntil = Date.now() + 30_000;
            startInFlight = false;
        }
    }

    // -------------------------------------------------------------------------
    // Navbar icon
    // -------------------------------------------------------------------------

    let navIcon = null;

    // Pending counts for the navbar badge (pairing requests + queued actions).
    const SUMMARY_INTERVAL_MS = 5_000;
    let pendingCounts = { pending_pairings: 0, pending_actions: 0 };

    async function pollSummary() {
        if (!sidecarRunning) return;
        try {
            if (!ADMIN_SECRET) await loadAdminSecret();
            const res = await sidecarAdmin("/summary", { signal: AbortSignal.timeout(2000) });
            if (res.ok) pendingCounts = await res.json();
        } catch { /* keep last known counts */ }
        updateNavIcon();
    }

    function _pendingTotal() {
        return (pendingCounts.pending_pairings || 0) + (pendingCounts.pending_actions || 0);
    }

    const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"
        viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2 L21.66 7 L21.66 17 L12 22 L2.34 17 L2.34 7 Z"/>
    </svg>`;

    const BASE_STYLE = [
        "display:inline-flex", "align-items:center", "justify-content:center",
        "width:2rem", "height:2rem", "border-radius:50%", "border:none",
        "background:transparent", "cursor:pointer",
        "transition:color .2s,background .15s", "margin-left:.25rem", "flex-shrink:0",
        "padding:0", "position:relative",
    ].join(";");

    const BADGE_STYLE = [
        "position:absolute", "top:-2px", "right:-4px",
        "min-width:16px", "height:16px", "padding:0 4px", "border-radius:8px",
        "background:#ef4444", "color:#fff", "font:700 10px/16px system-ui,sans-serif",
        "text-align:center", "pointer-events:none", "box-shadow:0 0 0 2px #202b33",
    ].join(";");

    function _iconColor() {
        if (sidecarRunning) return "#4ade80";
        if (startInFlight)  return "#facc15";
        return "#f87171";
    }

    function _iconTitle() {
        const base = "DeviceAuth — click to manage devices";
        let state = sidecarRunning ? "online" : (startInFlight ? "starting…" : "offline");
        const parts = [];
        const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
        if (pendingCounts.pending_pairings) parts.push(plural(pendingCounts.pending_pairings, "pairing"));
        if (pendingCounts.pending_actions)  parts.push(plural(pendingCounts.pending_actions, "action"));
        if (parts.length) state += ` · ${parts.join(", ")} pending`;
        return `${base} (${state})`;
    }

    function _applyState(el) {
        el.setAttribute("style", `${BASE_STYLE};color:${_iconColor()}`);
        el.setAttribute("title",      _iconTitle());
        el.setAttribute("aria-label", _iconTitle());

        // Only touch the DOM when the value changes: watchNavbar's
        // MutationObserver (childList+subtree on body) calls back into here,
        // so an unconditional textContent write would loop forever.
        const badge = el.querySelector(".sda-nav-badge");
        if (badge) {
            const n    = sidecarRunning ? _pendingTotal() : 0;
            const text = n > 99 ? "99+" : String(n);
            const disp = n > 0 ? "inline-block" : "none";
            if (badge.textContent !== text)   badge.textContent   = text;
            if (badge.style.display !== disp) badge.style.display = disp;
        }
    }

    function createNavIcon() {
        const b     = document.createElement("button");
        b.id        = "sda-nav-icon";
        b.type      = "button";
        b.innerHTML = ICON_SVG +
            `<span class="sda-nav-badge" style="${BADGE_STYLE};display:none"></span>`;
        _applyState(b);

        b.addEventListener("click", (e) => {
            e.preventDefault();
            openDeviceAuthModal();
        });
        b.addEventListener("mouseenter", () => { b.style.background = "rgba(255,255,255,.08)"; });
        b.addEventListener("mouseleave", () => { b.style.background = "transparent"; });

        return b;
    }

    function updateNavIcon() {
        if (navIcon && document.contains(navIcon)) {
            _applyState(navIcon);
        }
    }

    function ensureNavIcon() {
        if (navIcon && document.contains(navIcon)) {
            _applyState(navIcon);
            return;
        }

        const navButtons = document.querySelector(".navbar-buttons");
        if (!navButtons) return;

        document.getElementById("sda-nav-icon")?.remove();
        navIcon = createNavIcon();
        navButtons.prepend(navIcon);
    }

    function watchNavbar() {
        ensureNavIcon();
        new MutationObserver(ensureNavIcon).observe(document.body, {
            childList: true,
            subtree:   true,
        });
    }

    // -------------------------------------------------------------------------
    // Modal — styles injected once
    // -------------------------------------------------------------------------

    function injectStyles() {
        if (document.getElementById("sda-modal-styles")) return;
        const style = document.createElement("style");
        style.id = "sda-modal-styles";
        style.textContent = `
        .sda-modal-overlay {
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.72);
            display: flex; align-items: center; justify-content: center;
            z-index: 10000;
            backdrop-filter: blur(3px);
        }
        .sda-modal-box {
            background: #18181f;
            border: 1px solid #2a2a38;
            border-radius: 10px;
            width: min(720px, 94vw);
            max-height: 88vh;
            overflow-y: auto;
            color: #d4d4d8;
            font-family: system-ui, -apple-system, sans-serif;
            padding: 1.5rem 1.75rem 1.75rem;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        .sda-modal-header {
            display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 0.25rem;
        }
        .sda-modal-header h2 {
            margin: 0; font-size: 1.25rem; font-weight: 700; color: #fff;
        }
        .sda-modal-close {
            background: transparent; border: none; color: #71717a;
            font-size: 1.25rem; cursor: pointer; padding: 0.25rem 0.5rem;
            line-height: 1; border-radius: 4px;
        }
        .sda-modal-close:hover { color: #fff; background: rgba(255,255,255,0.06); }
        .sda-subtitle {
            color: #71717a; font-size: 0.85rem; margin-bottom: 1.5rem;
        }
        .sda-section-label {
            font-size: 0.7rem; font-weight: 600; letter-spacing: 0.1em;
            text-transform: uppercase; color: #71717a;
            margin: 1.25rem 0 0.6rem;
        }
        .sda-card {
            background: #0e0e12;
            border: 1px solid #2a2a38;
            border-radius: 8px;
            padding: 0.75rem 1rem;
            margin-bottom: 0.5rem;
            display: flex; align-items: center; justify-content: space-between;
            gap: 0.75rem;
        }
        .sda-card-info strong { color: #fff; font-size: 0.9rem; display: block; }
        .sda-card-info small { color: #71717a; font-size: 0.75rem; display: block; margin-top: 0.15rem; }
        .sda-code {
            font-family: 'Cascadia Code', 'Fira Mono', monospace;
            font-size: 1.35rem; font-weight: 700; letter-spacing: 0.2em;
            color: #7c6af7; background: #1e1b38;
            padding: 0.25rem 0.7rem; border-radius: 5px;
            flex-shrink: 0;
        }
        .sda-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
        .sda-btn {
            border: none; border-radius: 5px;
            padding: 0.4rem 0.85rem; font-size: 0.78rem; font-weight: 600;
            cursor: pointer; transition: opacity 0.15s;
        }
        .sda-btn:hover { opacity: 0.85; }
        .sda-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .sda-btn-approve { background: #7c6af7; color: #fff; }
        .sda-btn-deny { background: #2a2a38; color: #d4d4d8; }
        .sda-btn-revoke {
            background: #3b1a1a; color: #e06c75; border: 1px solid #5c2626;
        }
        .sda-empty {
            color: #52525b; font-size: 0.82rem; padding: 0.5rem 0 0.25rem;
            font-style: italic;
        }
        .sda-status-banner {
            padding: 0.6rem 0.85rem; border-radius: 6px;
            font-size: 0.8rem; margin-bottom: 1rem;
        }
        .sda-status-banner.error {
            background: rgba(224, 108, 117, 0.1);
            border: 1px solid rgba(224, 108, 117, 0.3);
            color: #e06c75;
        }
        .sda-status-banner.offline {
            background: rgba(250, 204, 21, 0.08);
            border: 1px solid rgba(250, 204, 21, 0.3);
            color: #facc15;
        }
        .sda-dot {
            width: 7px; height: 7px; border-radius: 50%;
            display: inline-block; margin-right: 0.4rem;
        }
        .sda-dot.online { background: #4ade80; animation: sdaPulse 2s infinite; }
        .sda-dot.offline { background: #f87171; }
        .sda-dot.starting { background: #facc15; animation: sdaPulse 1s infinite; }
        @keyframes sdaPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

        .sda-tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid #2a2a38; margin-bottom: 0.5rem; }
        .sda-tab {
            background: transparent; border: none; color: #a1a1aa;
            padding: 0.55rem 0.9rem; font-size: 0.85rem; font-weight: 600;
            cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
        }
        .sda-tab:hover { color: #fff; }
        .sda-tab.active { color: #fff; border-bottom-color: #7c6af7; }
        .sda-tab-count {
            display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 0.4rem;
            border-radius: 9px; background: #ef4444; color: #fff;
            font-size: 0.7rem; line-height: 18px; text-align: center;
        }
        .sda-toolbar {
            display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
            padding: 0.6rem 0; margin-bottom: 0.25rem;
        }
        .sda-toolbar .sda-spacer { flex: 1; }
        .sda-check { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; cursor: pointer; }
        .sda-check input { accent-color: #7c6af7; width: 15px; height: 15px; cursor: pointer; }
        .sda-check.danger { color: #e06c75; }
        .sda-card.selectable { cursor: pointer; justify-content: flex-start; }
        .sda-card.selected { border-color: #7c6af7; background: #15132a; }
        .sda-card-info { flex: 1; min-width: 0; }
        .sda-card-info a { color: #fff; text-decoration: none; }
        .sda-card-info a:hover { text-decoration: underline; }
        .sda-path {
            font-family: 'Cascadia Code', 'Fira Mono', monospace; font-size: 0.7rem;
            color: #52525b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .sda-reason { color: #a1a1aa; font-size: 0.75rem; font-style: italic; margin-top: 0.2rem; }
        .sda-btn-danger { background: #b91c1c; color: #fff; }
        .sda-pill {
            font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
            padding: 0.15rem 0.5rem; border-radius: 4px; flex-shrink: 0;
        }
        .sda-pill.approved  { background: rgba(74,222,128,.12); color: #4ade80; }
        .sda-pill.denied, .sda-pill.cancelled { background: #2a2a38; color: #a1a1aa; }
        .sda-pill.failed    { background: rgba(224,108,117,.15); color: #e06c75; }
        `;
        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------------
    // Modal — React component
    // -------------------------------------------------------------------------

    function DeviceAuthModal({ onClose }) {
        const { useState, useEffect, useRef } = React;
        const [pending, setPending]   = useState([]);
        const [devicesList, setDevs]  = useState([]);
        const [error, setError]       = useState(null);
        const [loading, setLoading]   = useState(true);
        const [online, setOnline]     = useState(sidecarRunning);
        const [tab, setTab]           = useState("devices");
        const [actionsList, setActs]  = useState([]);
        const [selected, setSelected] = useState(() => new Set());
        const [deleteFile, setDelFile] = useState(false);
        const [resolving, setResolving] = useState(false);
        const busyRef = useRef(false);

        async function refresh() {
            if (busyRef.current) return;
            busyRef.current = true;
            try {
                // quick health ping so we can show an offline banner
                let healthy = false;
                try {
                    const h = await sidecar("/health", { signal: AbortSignal.timeout(2000) });
                    healthy = h.ok;
                } catch {}
                setOnline(healthy);
                if (!healthy) {
                    setError("Sidecar is offline. Self-healing will retry shortly.");
                    setLoading(false);
                    return;
                }

                if (!ADMIN_SECRET) await loadAdminSecret();

                const [pRes, dRes, aRes] = await Promise.all([
                    sidecarAdmin("/pending"),
                    sidecarAdmin("/devices"),
                    sidecarAdmin("/actions?status=all"),
                ]);
                if ([pRes, dRes, aRes].some((r) => r.status === 401)) {
                    setError("Admin auth failed. Try closing and reopening the modal.");
                    setLoading(false);
                    return;
                }
                if (!pRes.ok || !dRes.ok) {
                    setError(`Sidecar error (pending=${pRes.status}, devices=${dRes.status})`);
                    setLoading(false);
                    return;
                }
                const pendingJson = await pRes.json();
                setPending(pendingJson);
                setDevs(await dRes.json());

                // Older sidecars don't have /actions — treat as empty rather than erroring.
                const acts = aRes.ok ? ((await aRes.json()).actions || []) : [];
                setActs(acts);
                const stillPending = new Set(acts.filter((a) => a.status === "pending").map((a) => a.id));
                setSelected((prev) => new Set([...prev].filter((id) => stillPending.has(id))));

                pendingCounts = {
                    pending_pairings: pendingJson.length,
                    pending_actions:  stillPending.size,
                };
                updateNavIcon();
                setError(null);
            } catch (e) {
                setError(e.message || String(e));
            } finally {
                setLoading(false);
                busyRef.current = false;
            }
        }

        useEffect(() => {
            document.body.style.overflow = "hidden";
            refresh();
            const iv = setInterval(refresh, 3000);
            return () => {
                clearInterval(iv);
                document.body.style.overflow = "";
            };
        }, []);

        async function approve(code) {
            try {
                const res = await sidecarAdmin("/pair/approve", {
                    method: "POST",
                    body: JSON.stringify({ code }),
                });
                if (!res.ok) {
                    const j = await res.json().catch(() => ({}));
                    setError(j.error || `Approve failed (${res.status})`);
                }
            } catch (e) { setError(e.message); }
            refresh();
        }

        async function deny(code) {
            try {
                await sidecarAdmin("/pair/deny", {
                    method: "POST",
                    body: JSON.stringify({ code }),
                });
            } catch (e) { setError(e.message); }
            refresh();
        }

        async function revoke(tokenId, name) {
            if (!confirm(`Revoke "${name}"? It will need to re-pair.`)) return;
            try {
                await sidecarAdmin("/revoke", {
                    method: "POST",
                    body: JSON.stringify({ token_id: tokenId }),
                });
            } catch (e) { setError(e.message); }
            refresh();
        }

        // ── Pending actions ────────────────────────────────────────────────
        const pendingActions  = actionsList.filter((a) => a.status === "pending" || a.status === "processing");
        const resolvedActions = actionsList.filter((a) => !pendingActions.includes(a)).slice(0, 15);
        const selectable      = pendingActions.filter((a) => a.status === "pending");
        const allSelected     = selectable.length > 0 && selectable.every((a) => selected.has(a.id));

        function toggle(id) {
            setSelected((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
            });
        }

        function toggleAll() {
            setSelected(allSelected ? new Set() : new Set(selectable.map((a) => a.id)));
        }

        async function resolve(ids, decision) {
            if (!ids.length) return;
            const label = `${ids.length} scene${ids.length === 1 ? "" : "s"}`;
            if (decision === "approve") {
                const msg = deleteFile
                    ? `Delete ${label} from Stash AND permanently delete the file(s) from disk?\n\nThis cannot be undone.`
                    : `Remove ${label} from the Stash library?\n\nFiles stay on disk; a rescan will re-import them.`;
                if (!confirm(msg)) return;
            }
            setResolving(true);
            try {
                const res = await sidecarAdmin("/actions/resolve", {
                    method: "POST",
                    body: JSON.stringify({ ids, decision, delete_file: deleteFile }),
                });
                const j = await res.json().catch(() => ({}));
                if (!res.ok) {
                    setError(j.error || `Resolve failed (${res.status})`);
                } else {
                    const failed = (j.results || []).filter((r) => r.status === "failed");
                    if (failed.length) {
                        setError(`${failed.length} action(s) failed: ${failed.map((f) => f.error).join("; ")}`);
                    }
                }
            } catch (e) { setError(e.message); }
            setResolving(false);
            setSelected(new Set());
            refresh();
        }

        function fmtSize(bytes) {
            if (!bytes) return "";
            const u = ["B", "KB", "MB", "GB", "TB"];
            let i = 0, n = bytes;
            while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
            return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
        }

        const fmtTime = (iso) => (iso || "").slice(0, 16).replace("T", " ");

        function actionCard(a) {
            const isSel = selected.has(a.id);
            const who   = (a.requesters || []).map((r) => r.device_name).join(", ") || "unknown";
            const reasons = (a.requesters || []).filter((r) => r.reason);
            return ce("div", {
                key: a.id,
                className: `sda-card selectable${isSel ? " selected" : ""}`,
                onClick: () => a.status === "pending" && toggle(a.id),
            },
                ce("label", { className: "sda-check", onClick: (e) => e.stopPropagation() },
                    ce("input", {
                        type: "checkbox", checked: isSel,
                        disabled: a.status !== "pending" || resolving,
                        onChange: () => toggle(a.id),
                    })
                ),
                ce("div", { className: "sda-card-info" },
                    ce("strong", null,
                        "🗑 ",
                        ce("a", {
                            href: `/scenes/${a.scene_id}`, target: "_blank", rel: "noopener",
                            onClick: (e) => e.stopPropagation(),
                        }, a.scene_title || `Scene ${a.scene_id}`)
                    ),
                    ce("small", null,
                        [a.studio, fmtSize(a.size), a.file_count > 1 ? `${a.file_count} files` : null,
                         `Requested by ${who}`, fmtTime(a.requested_at)]
                            .filter(Boolean).join(" · ")
                    ),
                    a.path && ce("div", { className: "sda-path", title: a.path }, a.path),
                    reasons.map((r, i) => ce("div", { key: i, className: "sda-reason" },
                        `“${r.reason}” — ${r.device_name}`))
                ),
                a.status === "processing"
                    ? ce("span", { className: "sda-pill" }, "Working…")
                    : ce("div", { className: "sda-actions", onClick: (e) => e.stopPropagation() },
                        ce("button", {
                            className: "sda-btn sda-btn-danger", disabled: resolving,
                            onClick: () => resolve([a.id], "approve"),
                        }, "Approve"),
                        ce("button", {
                            className: "sda-btn sda-btn-deny", disabled: resolving,
                            onClick: () => resolve([a.id], "deny"),
                        }, "Deny")
                    )
            );
        }

        function resolvedCard(a) {
            const who = (a.requesters || []).map((r) => r.device_name).join(", ");
            const detail = a.status === "approved"
                ? (a.delete_file ? "Scene + file deleted" : "Removed from library (file kept)")
                : a.status === "failed" ? `Error: ${a.error}` : null;
            return ce("div", { key: a.id, className: "sda-card" },
                ce("div", { className: "sda-card-info" },
                    ce("strong", null, a.scene_title || `Scene ${a.scene_id}`),
                    ce("small", null,
                        [detail, who && `from ${who}`, fmtTime(a.resolved_at)].filter(Boolean).join(" · "))
                ),
                ce("span", { className: `sda-pill ${a.status}` }, a.status)
            );
        }

        function renderActionsTab() {
            const selIds = [...selected];
            return [
                ce("div", { key: "tb", className: "sda-toolbar" },
                    ce("label", { className: "sda-check" },
                        ce("input", {
                            type: "checkbox", checked: allSelected,
                            disabled: !selectable.length || resolving, onChange: toggleAll,
                        }),
                        "Select all"
                    ),
                    ce("label", {
                        className: "sda-check danger",
                        title: "Off: scene is removed from Stash but the video stays on disk. " +
                               "On: the video file is deleted permanently.",
                    },
                        ce("input", {
                            type: "checkbox", checked: deleteFile,
                            onChange: (e) => setDelFile(e.target.checked),
                        }),
                        "Also delete files from disk"
                    ),
                    ce("span", { className: "sda-spacer" }),
                    ce("button", {
                        className: "sda-btn sda-btn-danger",
                        disabled: !selIds.length || resolving,
                        onClick: () => resolve(selIds, "approve"),
                    }, `Approve${selIds.length ? ` (${selIds.length})` : ""}`),
                    ce("button", {
                        className: "sda-btn sda-btn-deny",
                        disabled: !selIds.length || resolving,
                        onClick: () => resolve(selIds, "deny"),
                    }, `Deny${selIds.length ? ` (${selIds.length})` : ""}`)
                ),
                ce("div", { key: "pl", className: "sda-section-label" },
                    `⏳ Delete Requests${pendingActions.length ? ` (${pendingActions.length})` : ""}`),
                loading ? ce("div", { key: "ld", className: "sda-empty" }, "Loading…") :
                pendingActions.length === 0
                    ? ce("div", { key: "em", className: "sda-empty" }, "Nothing waiting for review.")
                    : ce("div", { key: "pa" }, pendingActions.map(actionCard)),
                resolvedActions.length > 0 &&
                    ce("div", { key: "rl", className: "sda-section-label" }, "🕘 Recently Resolved"),
                resolvedActions.length > 0 && ce("div", { key: "ra" }, resolvedActions.map(resolvedCard)),
            ];
        }

        const statusDotClass = online ? "online" : (startInFlight ? "starting" : "offline");
        const statusText = online ? "Sidecar online" : (startInFlight ? "Starting…" : "Offline");

        const tabBtn = (id, label, count) =>
            ce("button", {
                className: `sda-tab${tab === id ? " active" : ""}`,
                onClick: () => setTab(id),
            }, label, count > 0 && ce("span", { className: "sda-tab-count" }, count));

        return ce("div", {
            className: "sda-modal-overlay",
            onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
        },
            ce("div", { className: "sda-modal-box" },
                ce("div", { className: "sda-modal-header" },
                    ce("h2", null, "Device Authentication"),
                    ce("button", { className: "sda-modal-close", onClick: onClose, "aria-label": "Close" }, "✕")
                ),
                ce("div", { className: "sda-subtitle" },
                    ce("span", { className: `sda-dot ${statusDotClass}` }),
                    statusText,
                    " · Approve pairing requests, manage devices, and review headset requests."
                ),

                error && ce("div", { className: "sda-status-banner error" }, error),
                !online && !error && ce("div", { className: "sda-status-banner offline" },
                    "Sidecar is offline. The UI will reconnect automatically once it's back up."
                ),

                ce("div", { className: "sda-tabs" },
                    tabBtn("devices", "Devices", pending.length),
                    tabBtn("actions", "Pending Actions", selectable.length)
                ),

                tab === "actions" && renderActionsTab(),

                tab === "devices" && ce(React.Fragment, null,
                ce("div", { className: "sda-section-label" },
                    `⏳ Pending Pairing Requests${pending.length ? ` (${pending.length})` : ""}`
                ),
                loading ? ce("div", { className: "sda-empty" }, "Loading…") :
                pending.length === 0
                    ? ce("div", { className: "sda-empty" }, "No pending requests.")
                    : pending.map((p) =>
                        ce("div", { key: p.code, className: "sda-card" },
                            ce("div", { className: "sda-card-info" },
                                ce("strong", null, p.device_name || "Unknown device"),
                                ce("small", null, `Expires in ${p.expires_in}s`)
                            ),
                            ce("div", { className: "sda-code" }, p.code),
                            ce("div", { className: "sda-actions" },
                                ce("button", {
                                    className: "sda-btn sda-btn-approve",
                                    onClick: () => approve(p.code),
                                }, "Approve"),
                                ce("button", {
                                    className: "sda-btn sda-btn-deny",
                                    onClick: () => deny(p.code),
                                }, "Deny")
                            )
                        )
                    ),

                ce("div", { className: "sda-section-label" },
                    `✅ Paired Devices${devicesList.length ? ` (${devicesList.length})` : ""}`
                ),
                loading ? ce("div", { className: "sda-empty" }, "Loading…") :
                devicesList.length === 0
                    ? ce("div", { className: "sda-empty" }, "No paired devices yet.")
                    : devicesList.map((d) =>
                        ce("div", { key: d.token_id, className: "sda-card" },
                            ce("div", { className: "sda-card-info" },
                                ce("strong", null, d.device_name || "Unnamed device"),
                                ce("small", null,
                                    `Paired ${(d.paired_at || "").slice(0, 10)}` +
                                    (d.last_seen ? ` · Last seen ${d.last_seen.slice(0, 16).replace("T", " ")}` : "") +
                                    ` · Token ${d.token_hint}`
                                )
                            ),
                            ce("div", { className: "sda-actions" },
                                ce("button", {
                                    className: "sda-btn sda-btn-revoke",
                                    onClick: () => revoke(d.token_id, d.device_name),
                                }, "Revoke")
                            )
                        )
                    )
                )
            )
        );
    }

    // -------------------------------------------------------------------------
    // Modal mount/unmount
    // -------------------------------------------------------------------------

    let _modalRoot = null;

    function openDeviceAuthModal() {
        if (!React || !ReactDOM) {
            console.error(`[${PLUGIN_ID}] React/ReactDOM not available — cannot render modal.`);
            alert("MRStashDeviceAuth: React is not available. Check browser console.");
            return;
        }
        injectStyles();
        if (!_modalRoot) {
            _modalRoot = document.createElement("div");
            _modalRoot.id = "sda-modal-root";
            document.body.appendChild(_modalRoot);
        }
        ReactDOM.render(
            ce(DeviceAuthModal, { onClose: closeDeviceAuthModal }),
            _modalRoot
        );
    }

    function closeDeviceAuthModal() {
        if (_modalRoot && ReactDOM) {
            ReactDOM.unmountComponentAtNode(_modalRoot);
        }
    }

    // -------------------------------------------------------------------------
    // Boot
    // -------------------------------------------------------------------------

    async function boot() {
        await loadPort();
        await loadAdminSecret();  // best-effort; will be retried on demand
        watchNavbar();
        await checkHealth();
        await pollSummary();
        setInterval(checkHealth, HEALTH_INTERVAL_MS);
        setInterval(pollSummary, SUMMARY_INTERVAL_MS);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();