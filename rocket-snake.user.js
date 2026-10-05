// ==UserScript==
// @name         rocket-snake
// @namespace    https://github.com/jStrider/rocket-snake
// @version      0.7.0
// @description  Reply suggestions in Rocket.Chat (Claude + Onyx via local backend)
// @match        https://chat.example.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(() => {
  "use strict";

  const BACKEND = "http://127.0.0.1:8787";
  const SCRIPT_VERSION = GM_info.script.version;
  const HISTORY = 30;
  const COMPOSER = 'textarea[name="msg"]';
  const AUTO = true;
  const AUTO_DELAY_MS = 1500;
  const AUTO_MAX_AGE_MS = 24 * 3600 * 1000;
  const PREFETCH = true;
  const PREFETCH_POLL_MS = 15000;
  const ONYX = true;

  let lastComposer = null;
  document.addEventListener("focusin", (e) => {
    if (e.target.matches?.(COMPOSER)) lastComposer = e.target;
  });
  const composer = () => (lastComposer?.isConnected ? lastComposer : [...document.querySelectorAll(COMPOSER)].pop());

  const api = async (path) => {
    const r = await fetch(`/api/v1/${path}`, {
      headers: {
        "X-Auth-Token": localStorage.getItem("Meteor.loginToken"),
        "X-User-Id": localStorage.getItem("Meteor.userId"),
      },
    });
    const j = await r.json();
    if (!j.success) throw new Error(`${path}: ${j.error || r.status}`);
    return j;
  };

  const HISTORY_ENDPOINT = { c: "channels.history", p: "groups.history", d: "im.history" };

  async function currentTarget() {
    const m = location.pathname.match(/^\/(channel|group|direct)\/([^/]+)(?:\/thread\/([^/?#]+))?/);
    if (!m) throw new Error("Open a room first");
    const [, , key, tmid] = m;
    const info = await api(`rooms.info?roomId=${key}`).catch(() => api(`rooms.info?roomName=${key}`));
    return { room: info.room, tmid };
  }

  async function loadContext({ room, tmid }) {
    let msgs;
    if (tmid) {
      const [parent, replies] = await Promise.all([
        api(`chat.getMessage?msgId=${tmid}`),
        api(`chat.getThreadMessages?tmid=${tmid}&count=${HISTORY}`),
      ]);
      msgs = [parent.message, ...replies.messages];
    } else {
      msgs = (await api(`${HISTORY_ENDPOINT[room.t]}?roomId=${room._id}&count=200`)).messages
        .filter((x) => !x.tmid || x.tshow)
        .slice(0, HISTORY);
    }

    return {
      room: room.fname || room.name || "direct message",
      messages: msgs
        .filter((x) => !x.t)
        .map((x) => ({
          ts: x.ts,
          u: x.u?.name ? `${x.u.name} (@${x.u.username})` : x.u?.username,
          username: x.u?.username,
          msg: x.msg || x.attachments?.map((a) => a.description || a.title).filter(Boolean).join(" ") || "",
        }))
        .filter((x) => x.msg)
        .sort((a, b) => a.ts.localeCompare(b.ts)),
    };
  }

  function insert(text) {
    const ta = composer();
    if (!ta) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  }

  // --- UI ---------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    @keyframes rs-pulse { 50% { opacity: .35 } }
    #rs-bar { position: fixed; z-index: 99999; display: none; gap: 6px; flex-wrap: nowrap; align-items: center;
      justify-content: flex-end; overflow: hidden; font: 12px/1.3 sans-serif; pointer-events: none; }
    #rs-bar > * { pointer-events: auto; }
    .rs-chip { display: inline-flex; align-items: center; gap: 4px; min-width: 60px; max-width: 280px; flex: 0 1 auto;
      padding: 4px 4px 4px 10px;
      border: 1px solid #3a3f47; border-radius: 14px; background: #2f343d; color: #e4e7ea; cursor: pointer; }
    .rs-chip:hover { border-color: #1d74f5; }
    .rs-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rs-label { font-size: 9px; font-weight: bold; color: #1d74f5; }
    .rs-x, .rs-icon { border: none; background: none; color: #9ea2a8; cursor: pointer; padding: 0 4px;
      font-size: 13px; line-height: 1; }
    .rs-x:hover, .rs-icon:hover { color: #e4e7ea; }
    .rs-note { color: #9ea2a8; font-size: 11px; padding: 0 4px; }
  `;
  document.head.append(style);

  const bar = Object.assign(document.createElement("div"), { id: "rs-bar" });
  const btn = document.createElement("button");
  btn.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>' +
    '<path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
  btn.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:99999;width:32px;height:32px;border-radius:6px;" +
    "display:flex;align-items:center;justify-content:center;border:1px solid #3a3f47;background:#2f343d;" +
    "color:#9ea2a8;cursor:pointer;opacity:.7;transition:opacity .15s,color .15s";
  btn.onmouseenter = () => (btn.style.opacity = "1");
  btn.onmouseleave = () => (btn.style.opacity = ".7");
  const badge = document.createElement("span");
  badge.style.cssText =
    "position:absolute;top:-5px;right:-5px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;" +
    "background:#f5455c;color:#fff;font:bold 9px/14px sans-serif;text-align:center;display:none";
  btn.append(badge);
  document.body.append(bar, btn);

  let pending = 0;
  const busy = (on) => {
    pending += on ? 1 : -1;
    btn.style.color = pending > 0 ? "#1d74f5" : "#9ea2a8";
    btn.style.animation = pending > 0 ? "rs-pulse 1s ease-in-out infinite" : "";
  };

  const el = (tag, cls, text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });

  // Sit inside the empty composer, right-aligned next to the placeholder, so the conversation stays visible.
  function placeBar() {
    const ta = composer();
    if (!ta || bar.style.display === "none") return;
    const r = ta.getBoundingClientRect();
    const width = r.width * 0.75;
    Object.assign(bar.style, {
      left: `${r.right - width - 8}px`,
      width: `${width}px`,
      top: `${r.top + (r.height - bar.offsetHeight) / 2}px`,
    });
  }
  setInterval(placeBar, 300);
  window.addEventListener("resize", placeBar);

  const hideBar = () => (bar.style.display = "none");
  document.addEventListener("input", (e) => {
    if (!e.target.matches?.(COMPOSER) || !bar.firstChild) return;
    bar.style.display = e.target.value ? "none" : "flex";
    placeBar();
  });
  function showBar(nodes) {
    bar.replaceChildren(...nodes);
    bar.style.display = "flex";
    placeBar();
  }

  // --- Backend ----------------------------------------------------------
  let usage = null;

  function callBackend(method, path, payload) {
    return new Promise((resolve, reject) =>
      GM_xmlhttpRequest({
        method,
        url: BACKEND + path,
        headers: { "Content-Type": "application/json", "X-Rocket-Snake": "1" },
        data: payload && JSON.stringify(payload),
        timeout: 180000,
        onload: (r) => {
          const j = JSON.parse(r.responseText || "{}");
          if (j.usage) usage = j.usage;
          r.status === 200 ? resolve(j) : reject(new Error(j.error || `HTTP ${r.status}`));
        },
        onerror: () => reject(new Error("Backend unreachable — is server.py running?")),
        ontimeout: () => reject(new Error("Backend timeout")),
      })
    );
  }

  const refreshStats = () =>
    callBackend("GET", "/stats")
      .then((s) => (usage = s))
      .catch(() => {})
      .finally(updateBadge);

  // --- Suggestions --------------------------------------------------------
  const cache = new Map();
  const ready = new Map();
  let me;

  const needsReply = (last) => last && last.username !== me && Date.now() - Date.parse(last.ts) < AUTO_MAX_AGE_MS;

  function cached(key, fn, force) {
    if (force) cache.delete(key);
    if (!cache.has(key)) cache.set(key, fn().catch((e) => (cache.delete(key), Promise.reject(e))));
    return cache.get(key);
  }

  async function start(target, { kind, draft = "", force = false }) {
    me ??= (await api("me")).username;
    const ctx = await loadContext(target);
    const last = ctx.messages.at(-1);
    if (kind !== "manual" && !needsReply(last)) return null;
    const payload = { ...ctx, me, draft, kind };
    const fast = () => callBackend("POST", "/suggest", payload);
    const onyx = () =>
      ONYX && usage?.onyx_enabled !== false
        ? callBackend("POST", "/suggest", { ...payload, onyx: true })
        : Promise.resolve(null);
    if (draft) return { fast: fast(), onyx: onyx() };
    const key = `${target.room._id}|${target.tmid || ""}|${last?.ts}`;
    return { fast: cached(`${key}|fast`, fast, force), onyx: cached(`${key}|onyx`, onyx, force) };
  }

  function infoText() {
    const lines = [];
    if (usage) {
      const t = usage.today;
      lines.push(`Aujourd'hui : ${t.calls} appels · $${t.cost_usd.toFixed(2)} / $${usage.daily_budget_usd}`);
      lines.push(`7 jours : ${usage.week.calls} appels · $${usage.week.cost_usd.toFixed(2)}`);
    }
    const sv = usage?.server_version ?? "?";
    lines.push(`script v${SCRIPT_VERSION} · serveur v${sv}${sv !== SCRIPT_VERSION ? " ⚠️ versions différentes" : ""}`);
    return lines.join("\n");
  }

  function chip(text, { label, title } = {}) {
    const c = el("span", "rs-chip");
    c.title = title ? `${text}\n\n${title}` : text;
    if (label) c.append(el("span", "rs-label", label));
    c.append(el("span", "rs-text", text));
    const x = el("button", "rs-x", "×");
    x.title = "Ignorer";
    x.onclick = (e) => {
      e.stopPropagation();
      c.remove();
      if (!bar.querySelector(".rs-chip")) (bar.replaceChildren(), hideBar());
    };
    c.append(x);
    c.onclick = () => {
      insert(text);
      bar.replaceChildren();
      hideBar();
    };
    return c;
  }

  function controls() {
    const regen = el("button", "rs-icon", "↻");
    regen.title = "Regénérer";
    regen.onclick = () => run("manual", { force: true });
    const info = el("button", "rs-icon", usage?.server_version && usage.server_version !== SCRIPT_VERSION ? "⚠️" : "ⓘ");
    info.title = infoText();
    const close = el("button", "rs-icon", "✕");
    close.title = "Fermer (Esc)";
    close.onclick = () => (bar.replaceChildren(), hideBar());
    return [regen, info, close];
  }

  function render(fast, onyx) {
    const nodes = fast.suggestions.map((s) => chip(s));
    if (onyx === undefined) nodes.push(el("span", "rs-note", "Onyx…"));
    else if (onyx?.suggestions?.length) {
      const sources = onyx.sources?.length ? `Sources : ${onyx.sources.join(", ")}` : "";
      nodes.push(...onyx.suggestions.map((s) => chip(s, { label: "ONYX", title: sources })));
    }
    showBar([...nodes, ...controls()]);
  }

  async function run(kind, { force = false } = {}) {
    const path = location.pathname;
    const draft = composer()?.value || "";
    if (kind === "auto" && draft) return;
    if (kind === "manual") showBar([el("span", "rs-note", "⏳ Génération…"), ...controls()]);
    busy(true);
    try {
      const target = await currentTarget();
      const job = await start(target, { kind, draft, force });
      if (!job) return;
      ready.delete(target.room._id);
      updateBadge();
      let fast;
      let onyx;
      job.onyx
        .then((r) => (onyx = r), () => (onyx = null))
        .then(() => fast && location.pathname === path && bar.style.display !== "none" && render(fast, onyx));
      fast = await job.fast;
      if (location.pathname === path) render(fast, onyx);
    } catch (e) {
      if (kind === "manual") showBar([el("span", "rs-note", `❌ ${e.message}`), ...controls()]);
    } finally {
      busy(false);
      updateBadge();
    }
  }

  function updateBadge() {
    const mismatch = usage && usage.server_version !== SCRIPT_VERSION;
    badge.style.display = ready.size || mismatch ? "block" : "none";
    badge.style.background = ready.size ? "#f5455c" : "#f38c39";
    badge.textContent = ready.size ? String(ready.size) : "!";
    const parts = ["Suggérer une réponse (Ctrl+Shift+Space)"];
    if (ready.size) parts.push(`Suggestions prêtes : ${[...ready.values()].join(", ")}`);
    parts.push(infoText());
    btn.title = parts.join("\n");
  }

  let lastPath = location.pathname;
  setInterval(() => {
    if (!AUTO || location.pathname === lastPath) return;
    lastPath = location.pathname;
    bar.replaceChildren();
    hideBar();
    setTimeout(() => location.pathname === lastPath && run("auto"), AUTO_DELAY_MS);
  }, 500);

  // Warm the cache when someone DMs or mentions me, so opening the room is instant.
  let since = new Date().toISOString();
  async function prefetch() {
    const now = new Date().toISOString();
    try {
      const { update } = await api(`subscriptions.get?updatedSince=${encodeURIComponent(since)}`);
      since = now;
      for (const s of update) {
        const wanted = s.t === "d" || s.userMentions > 0 || s.groupMentions > 0;
        if (!wanted || !s.alert || !HISTORY_ENDPOINT[s.t]) continue;
        busy(true);
        try {
          const job = await start({ room: { _id: s.rid, t: s.t, name: s.name, fname: s.fname } }, { kind: "prefetch" });
          if (job) {
            await job.fast;
            ready.set(s.rid, s.fname || s.name);
          }
        } catch {
          // Budget reached or backend down: skip this room.
        } finally {
          busy(false);
          updateBadge();
        }
      }
    } catch {
      // Rocket.Chat unavailable: retry on next tick.
    }
  }
  if (PREFETCH) setInterval(prefetch, PREFETCH_POLL_MS);
  refreshStats();

  btn.onclick = () => run("manual");
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "Space") {
      e.preventDefault();
      run("manual");
    }
    if (e.key === "Escape") (bar.replaceChildren(), hideBar());
  });
})();
