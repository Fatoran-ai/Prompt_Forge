import { app } from "../../scripts/app.js";

console.log("[PromptForge] JS FILE LOADED");

const API = "/forge";
const NODE_TYPE = "PromptForge";
const HISTORY_LIMIT = 10;
const HISTORY_SHOW = 5;

const BUTTON_ROW = 30;
const NODE_HEADER = 30;
const NODE_PADDING = 20;

// ---- State ---------------------------------------------------------------

function getState(node) {
    if (!node.properties) node.properties = {};
    let s = node.properties.promptForgeState;
    if (typeof s === "string") {
        try { s = JSON.parse(s); } catch { s = null; }
    }
    if (!s || typeof s !== "object") s = {};
    return s;
}

function saveState(node, patch) {
    if (!node.properties) node.properties = {};
    const cur = getState(node);
    node.properties.promptForgeState = { ...cur, ...patch };
}

function getProfileState(node, profile) {
    const s = getState(node);
    const perProfile = s.perProfile || {};
    return perProfile[profile] || {};
}

function saveProfileState(node, profile, patch) {
    const s = getState(node);
    const perProfile = s.perProfile || {};
    perProfile[profile] = { ...(perProfile[profile] || {}), ...patch };
    saveState(node, { perProfile });
}

function pushHistory(node, profile, entry) {
    const s = getState(node);
    const histories = s.histories || {};
    const arr = histories[profile] || [];
    arr.unshift(entry);
    if (arr.length > HISTORY_LIMIT) arr.length = HISTORY_LIMIT;
    histories[profile] = arr;
    saveState(node, { histories });
}

function getHistory(node, profile) {
    const s = getState(node);
    const histories = s.histories || {};
    return histories[profile] || [];
}

function clearHistory(node, profile) {
    const s = getState(node);
    const histories = s.histories || {};
    histories[profile] = [];
    saveState(node, { histories });
}

function getPromptWidget(node) {
    return node.widgets?.find(w => w.name === "prompt");
}

function shortTs(ts) {
    try {
        const d = new Date(ts);
        const p = n => String(n).padStart(2, "0");
        return p(d.getDate()) + "." + p(d.getMonth() + 1) + " " +
               p(d.getHours()) + ":" + p(d.getMinutes());
    } catch { return "?"; }
}

function truncate(text, n) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}

// ---- Overlay -------------------------------------------------------------

let overlayRef = null;

function buildOverlay() {
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.65);" +
        "display:none;align-items:center;justify-content:center;";

    const panel = document.createElement("div");
    panel.style.cssText =
        "background:#1c1c1c;color:#ddd;border-radius:10px;padding:22px 24px;" +
        "width:680px;max-width:94vw;max-height:88vh;overflow-y:auto;" +
        "font-family:system-ui,sans-serif;font-size:13px;" +
        "box-shadow:0 12px 48px rgba(0,0,0,.65);" +
        "border:1px solid #2c2c2c;";

    panel.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;' +
        'margin-bottom:12px;">' +
        '  <h3 style="margin:0;font-weight:600;font-size:15px;">Prompt Forge</h3>' +
        '  <button id="pf-close" style="background:transparent;color:#777;' +
        'border:none;font-size:20px;cursor:pointer;line-height:1;' +
        'padding:0 6px;">\u00D7</button>' +
        '</div>' +

        '<div id="pf-tabs" style="display:flex;flex-wrap:wrap;gap:4px;' +
        'margin-bottom:14px;border-bottom:1px solid #2c2c2c;padding-bottom:10px;"></div>' +

        '<label style="display:block;margin-bottom:5px;color:#aaa;' +
        'font-size:11px;text-transform:uppercase;letter-spacing:.5px;">Brief</label>' +
        '<textarea id="pf-brief" rows="4" style="width:100%;box-sizing:border-box;' +
        'background:#252525;color:#eee;border:1px solid #333;border-radius:6px;' +
        'padding:9px;resize:vertical;font-family:inherit;font-size:13px;' +
        'outline:none;" placeholder="Describe the scene..."></textarea>' +

        '<div id="pf-custom-wrap" style="display:none;margin-top:12px;">' +
        '  <label style="display:block;margin-bottom:5px;color:#aaa;' +
        'font-size:11px;text-transform:uppercase;letter-spacing:.5px;">' +
        'System prompt (Custom tab only)</label>' +
        '  <textarea id="pf-custom-system" rows="4" style="width:100%;box-sizing:border-box;' +
        'background:#252525;color:#eee;border:1px solid #333;border-radius:6px;' +
        'padding:9px;resize:vertical;font-size:12px;' +
        'outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;" ' +
        'placeholder="Optional: your own system prompt for this run..."></textarea>' +
        '</div>' +

        '<div style="display:flex;gap:12px;margin-top:14px;">' +
        '  <div style="flex:1;">' +
        '    <label style="display:block;margin-bottom:5px;color:#aaa;' +
        'font-size:11px;text-transform:uppercase;letter-spacing:.5px;">Model</label>' +
        '    <select id="pf-model" style="width:100%;background:#252525;' +
        'color:#eee;border:1px solid #333;border-radius:6px;padding:7px;' +
        'font-family:inherit;font-size:12px;"></select>' +
        '  </div>' +
        '  <div style="flex:1;">' +
        '    <label style="display:block;margin-bottom:5px;color:#aaa;' +
        'font-size:11px;text-transform:uppercase;letter-spacing:.5px;">Creativity</label>' +
        '    <select id="pf-creativity" style="width:100%;background:#252525;' +
        'color:#eee;border:1px solid #333;border-radius:6px;padding:7px;' +
        'font-family:inherit;font-size:12px;"></select>' +
        '  </div>' +
        '</div>' +

        '<div style="margin-top:14px;">' +
        '  <label style="display:block;margin-bottom:5px;color:#aaa;' +
        'font-size:11px;text-transform:uppercase;letter-spacing:.5px;">' +
        'Detail: <span id="pf-detail-label" style="color:#c8a44a;">3</span></label>' +
        '  <input id="pf-detail" type="range" min="1" max="7" step="1" value="3" ' +
        'style="width:100%;accent-color:#8a7ac4;cursor:pointer;">' +
        '</div>' +

        '<div id="pf-status" style="margin-top:14px;min-height:18px;color:#c8a44a;' +
        'font-size:12px;"></div>' +

        '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">' +
        '  <button id="pf-run" style="padding:7px 22px;background:#6d5aa8;color:#fff;' +
        'border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;">' +
        'Generate</button>' +
        '</div>' +

        '<div style="margin-top:18px;border-top:1px solid #2c2c2c;padding-top:14px;">' +
        '  <div style="display:flex;justify-content:space-between;align-items:center;' +
        'margin-bottom:8px;">' +
        '    <span id="pf-history-title" style="color:#888;font-size:11px;' +
        'text-transform:uppercase;letter-spacing:.5px;">Last 0 generated prompts</span>' +
        '    <button id="pf-history-clear" style="background:transparent;color:#777;' +
        'border:1px solid #333;border-radius:4px;cursor:pointer;font-size:10px;' +
        'padding:3px 9px;">Clear history</button>' +
        '  </div>' +
        '  <div id="pf-history-list" style="max-height:260px;overflow-y:auto;">' +
        '  </div>' +
        '</div>';

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return { overlay, panel };
}

// ---- API -----------------------------------------------------------------

async function fetchProfiles() {
    const res = await fetch(API + "/profiles", { method: "POST" });
    return res.json();
}

async function fetchModels() {
    const res = await fetch(API + "/models", { method: "POST" });
    return res.json();
}

async function runForge(body) {
    const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return res.json();
}

// ---- History render ------------------------------------------------------

function renderHistory(node, profile) {
    if (!overlayRef) return;
    const { panel } = overlayRef;
    const list = panel.querySelector("#pf-history-list");
    const title = panel.querySelector("#pf-history-title");
    const history = getHistory(node, profile);

    title.textContent = "Last " + history.length + " generated prompt" +
                       (history.length === 1 ? "" : "s") + " (" + profile + ")";

    list.innerHTML = "";
    if (!history.length) {
        const empty = document.createElement("div");
        empty.style.cssText = "color:#555;font-size:12px;padding:6px 2px;";
        empty.textContent = "No history yet.";
        list.appendChild(empty);
        return;
    }

    history.slice(0, HISTORY_SHOW).forEach((item, idx) => {
        const row = document.createElement("div");
        row.style.cssText =
            "background:#222;border:1px solid #2c2c2c;border-radius:6px;" +
            "padding:10px 12px;margin-bottom:8px;font-size:12px;";

        const meta = document.createElement("div");
        meta.style.cssText = "color:#888;font-size:11px;margin-bottom:6px;";
        meta.textContent = (idx + 1) + ". " + shortTs(item.ts) + " \u00B7 " +
            (item.creativity || "balanced") + " \u00B7 D" +
            (item.detail || "3") + " \u00B7 " + truncate(item.model || "", 34);

        const brief = document.createElement("div");
        brief.style.cssText = "color:#b8c89a;margin-bottom:5px;line-height:1.35;";
        brief.textContent = truncate(item.brief || "", 140);

        const prompt = document.createElement("div");
        prompt.style.cssText =
            "color:#aaa;line-height:1.4;margin-bottom:8px;" +
            "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;" +
            "font-size:11px;white-space:pre-wrap;";
        prompt.textContent = truncate(item.prompt || "", 240);

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:6px;";

        const restore = document.createElement("button");
        restore.textContent = "Restore";
        restore.style.cssText =
            "background:#6d5aa8;color:#fff;border:none;border-radius:4px;" +
            "padding:4px 12px;font-size:11px;cursor:pointer;";
        restore.onclick = () => {
            const w = getPromptWidget(node);
            if (w) w.value = item.prompt || "";
            const briefEl = panel.querySelector("#pf-brief");
            if (briefEl) briefEl.value = item.brief || "";
            app.graph.setDirtyCanvas(true);
            const s = panel.querySelector("#pf-status");
            if (s) s.textContent = "Restored from history.";
        };

        const reuseBrief = document.createElement("button");
        reuseBrief.textContent = "Use brief";
        reuseBrief.style.cssText =
            "background:#333;color:#ccc;border:1px solid #444;" +
            "border-radius:4px;padding:4px 12px;font-size:11px;cursor:pointer;";
        reuseBrief.onclick = () => {
            const briefEl = panel.querySelector("#pf-brief");
            if (briefEl) briefEl.value = item.brief || "";
        };

        actions.append(restore, reuseBrief);
        row.append(meta, brief, prompt, actions);
        list.appendChild(row);
    });
}

// ---- Detail label (uses per-profile level names) -------------------------

function updateDetailLabel(panel, profileId) {
    const d = panel.querySelector("#pf-detail");
    const label = panel.querySelector("#pf-detail-label");
    if (!d || !label) return;
    const level = d.value;
    const profiles = overlayRef && overlayRef.profiles;
    const info = profiles && profiles.profiles && profiles.profiles[profileId];
    const levels = (info && info.detail_levels) || {};
    const name = levels[level];
    label.textContent = name ? (level + " \u2014 " + name) : level;
}

// ---- Overlay open --------------------------------------------------------

async function openForge(node) {
    if (!overlayRef) {
        overlayRef = buildOverlay();
        wireOverlay(overlayRef);
        await initOverlay();
    }
    const { overlay, panel } = overlayRef;
    overlay.style.display = "flex";
    overlayRef.node = node;

    const state = getState(node);
    const profile = state.profile || "anima";

    await switchProfile(profile, node, /*fromOpen*/ true);
}

async function initOverlay() {
    if (!overlayRef) return;
    const { panel } = overlayRef;
    const profilesData = await fetchProfiles();
    const modelsData = await fetchModels();

    overlayRef.profiles = profilesData;

    const modelSel = panel.querySelector("#pf-model");
    modelSel.innerHTML = "";
    for (const m of modelsData.models || []) {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.label;
        modelSel.appendChild(o);
    }

    const tabsEl = panel.querySelector("#pf-tabs");
    tabsEl.innerHTML = "";
    overlayRef.tabEls = {};
    for (const pid of profilesData.order || []) {
        const info = profilesData.profiles[pid];
        if (!info) continue;
        const tab = document.createElement("button");
        tab.dataset.profile = pid;
        tab.textContent = info.label || pid;
        tab.style.cssText =
            "background:transparent;color:#aaa;border:1px solid #333;" +
            "border-radius:5px;padding:5px 12px;font-size:12px;cursor:pointer;" +
            "font-family:inherit;";
        tab.onclick = () => switchProfile(pid, overlayRef.node);
        tabsEl.appendChild(tab);
        overlayRef.tabEls[pid] = tab;
    }
}

async function switchProfile(profileId, node, fromOpen) {
    if (!overlayRef || !node) return;
    const { panel, profiles } = overlayRef;

    overlayRef.profile = profileId;
    saveState(node, { profile: profileId });

    for (const [pid, el] of Object.entries(overlayRef.tabEls || {})) {
        if (pid === profileId) {
            el.style.background = "#6d5aa8";
            el.style.color = "#fff";
            el.style.borderColor = "#6d5aa8";
        } else {
            el.style.background = "transparent";
            el.style.color = "#aaa";
            el.style.borderColor = "#333";
        }
    }

    const info = profiles.profiles[profileId];
    if (!info) return;

    const customWrap = panel.querySelector("#pf-custom-wrap");
    customWrap.style.display = profileId === "custom" ? "block" : "none";

    const ps = getProfileState(node, profileId);
    const modelSel = panel.querySelector("#pf-model");
    if (ps.model) modelSel.value = ps.model;

    const crSel = panel.querySelector("#pf-creativity");
    crSel.innerHTML = "";
    for (const k of info.creativity || []) {
        const o = document.createElement("option");
        o.value = k;
        o.textContent = k;
        crSel.appendChild(o);
    }
    crSel.value = ps.creativity || info.default_creativity || "balanced";

    const dtSel = panel.querySelector("#pf-detail");
    const detailLevels = info.detail_levels || {};
    const count = Object.keys(detailLevels).length || 5;
    dtSel.min = "1";
    dtSel.max = String(count);
    dtSel.value = ps.detail || info.default_detail || 3;
    updateDetailLabel(panel, profileId);

    const briefEl = panel.querySelector("#pf-brief");
    briefEl.value = ps.brief || getState(node).brief || "";

    const csEl = panel.querySelector("#pf-custom-system");
    csEl.value = ps.custom_system_prompt || "";

    const status = panel.querySelector("#pf-status");
    status.textContent = "";
    panel.querySelector("#pf-run").disabled = false;

    renderHistory(node, profileId);
}

// ---- Wiring --------------------------------------------------------------

function wireOverlay({ overlay, panel }) {
    const brief = panel.querySelector("#pf-brief");
    const customSystem = panel.querySelector("#pf-custom-system");
    const model = panel.querySelector("#pf-model");
    const crSel = panel.querySelector("#pf-creativity");
    const dtSel = panel.querySelector("#pf-detail");
    const status = panel.querySelector("#pf-status");
    const runBtn = panel.querySelector("#pf-run");
    const closeBtn = panel.querySelector("#pf-close");
    const clearHist = panel.querySelector("#pf-history-clear");

    let running = false;

    dtSel.oninput = () => updateDetailLabel(panel, overlayRef.profile);

    closeBtn.onclick = () => {
        overlay.style.display = "none";
    };

    clearHist.onclick = () => {
        const node = overlayRef.node;
        if (!node) return;
        clearHistory(node, overlayRef.profile);
        renderHistory(node, overlayRef.profile);
        status.textContent = "History cleared.";
    };

    runBtn.onclick = async () => {
        if (running) return;
        const node = overlayRef.node;
        const profile = overlayRef.profile;
        const text = brief.value.trim();
        if (!text) {
            status.textContent = "Write a brief first.";
            return;
        }

        running = true;
        runBtn.disabled = true;
        status.textContent = "Generating...";

        saveProfileState(node, profile, {
            brief: text,
            model: model.value,
            creativity: crSel.value,
            detail: dtSel.value,
            custom_system_prompt: customSystem.value.trim(),
        });
        saveState(node, { brief: text });

        let result;
        try {
            result = await runForge({
                request_id: crypto.randomUUID(),
                profile,
                brief: text,
                model: model.value,
                creativity: crSel.value,
                detail: dtSel.value,
                custom_system_prompt: customSystem.value.trim(),
            });
        } catch (e) {
            result = { error: "network", message: String(e) };
        }

        running = false;
        runBtn.disabled = false;

        if (result.error) {
            status.textContent = result.message || result.error;
            return;
        }

        const widget = getPromptWidget(node);
        if (widget) widget.value = result.prompt;
        app.graph.setDirtyCanvas(true);

        pushHistory(node, profile, {
            prompt: result.prompt,
            brief: text,
            model: model.value,
            creativity: crSel.value,
            detail: dtSel.value,
            ts: Date.now(),
        });
        renderHistory(node, profile);

        status.textContent = "Done in " +
            ((result.stats && result.stats.seconds) || "?") + "s.";
        setTimeout(() => {
            overlay.style.display = "none";
            status.textContent = "";
        }, 700);
    };

    overlay.onclick = (e) => {
        if (e.target === overlay) overlay.style.display = "none";
    };
}

// ---- Node hook -----------------------------------------------------------

app.registerExtension({
    name: "PromptForge.Universal",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            orig?.apply(this, arguments);
            const node = this;

            if (!node.properties) node.properties = {};

            const row = document.createElement("div");
            row.style.cssText =
                "display:flex;gap:4px;width:100%;padding:2px 4px;" +
                "box-sizing:border-box;";

            const mkBtn = (label, title, bg) => {
                const b = document.createElement("button");
                b.textContent = label;
                b.title = title;
                b.style.cssText =
                    "flex:1 1 0;min-width:0;height:26px;padding:0 6px;" +
                    "font-size:11px;font-family:inherit;cursor:pointer;" +
                    "line-height:1;background:" + (bg || "#333") + ";color:#ddd;" +
                    "border:1px solid #555;border-radius:4px;" +
                    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
                    "box-sizing:border-box;display:inline-flex;" +
                    "align-items:center;justify-content:center;";
                return b;
            };

            const clearBtn = mkBtn("Clear", "Clear the prompt");
            const copyBtn  = mkBtn("Copy",  "Copy to clipboard");
            const forgeBtn = mkBtn("\u26A1 Forge", "Open Forge overlay", "#6d5aa8");

            clearBtn.onclick = () => {
                const w = getPromptWidget(node);
                if (w) w.value = "";
                app.graph.setDirtyCanvas(true);
            };

            copyBtn.onclick = async () => {
                const w = getPromptWidget(node);
                try {
                    await navigator.clipboard.writeText(w?.value || "");
                    copyBtn.textContent = "Copied";
                    setTimeout(() => { copyBtn.textContent = "Copy"; }, 900);
                } catch (e) { console.error("Copy failed:", e); }
            };

            forgeBtn.onclick = () => openForge(node);

            row.append(clearBtn, copyBtn, forgeBtn);

            let buttonsWidget = null;
            if (typeof node.addDOMWidget === "function") {
                buttonsWidget = node.addDOMWidget(
                    "prompt_forge_buttons", "buttons", row,
                    { serialize: false, hideOnZoom: false }
                );
            } else {
                node.addWidget("button", "Clear prompt", null, clearBtn.onclick);
                node.addWidget("button", "Copy prompt", null, copyBtn.onclick);
                node.addWidget("button", "Forge prompt", null, forgeBtn.onclick);
                return;
            }

            if (buttonsWidget) {
                buttonsWidget.computeSize = function (width) {
                    return [width, BUTTON_ROW];
                };
            }

            const promptWidget = getPromptWidget(node);
            if (promptWidget) {
                const origPromptCompute = promptWidget.computeSize;
                promptWidget.computeSize = function (width) {
                    const nodeH = node.size ? node.size[1] : 0;
                    if (nodeH > 0) {
                        const reserved = NODE_HEADER + BUTTON_ROW + NODE_PADDING;
                        return [width, Math.max(60, nodeH - reserved)];
                    }
                    if (origPromptCompute) return origPromptCompute.call(this, width);
                    return [width, 100];
                };
            }

            requestAnimationFrame(() => {
                const state = getState(node);
                if (state.initialSized) return;
                const width = Math.max(node.size[0], 420);
                const height = NODE_HEADER + 140 + BUTTON_ROW + NODE_PADDING;
                node.setSize([width, height]);
                saveState(node, { initialSized: true });
            });
        };
    },
});