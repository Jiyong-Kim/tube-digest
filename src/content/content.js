(() => {
  if (globalThis.__tubeDigestLoaded) return;
  globalThis.__tubeDigestLoaded = true;

  const CACHE_KEY = "summaryCache";
  const SOURCE_LABEL = {
    timedtext: "자막 트랙",
    innertube: "자막 패널",
    dom: "화면 스크립트",
  };

  let host = null;
  let shadow = null;
  let refs = null;
  let runId = 0;
  let mountedVideoId = "";
  let collapsed = false;
  let cssText = "";
  let mounting = null;
  let hostGeneration = 0;

  boot();
  document.addEventListener("yt-navigate-finish", boot);
  window.addEventListener("popstate", boot);

  let remountTimer = 0;
  const observer = new MutationObserver(() => {
    if (!isWatchPage() || document.getElementById("tube-digest-host")) return;
    clearTimeout(remountTimer);
    remountTimer = setTimeout(boot, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["dark"] });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.openrouterApiKey || !refs) return;
    if (!changes.openrouterApiKey.newValue) renderMissingKey();
  });

  async function boot() {
    if (!isWatchPage()) {
      if (host) host.hidden = true;
      mountedVideoId = "";
      return;
    }

    const generationBefore = hostGeneration;
    await ensureHost();
    const videoId = getVideoId();
    if (!videoId || !refs) return;
    host.hidden = false;
    const recreated = hostGeneration !== generationBefore;

    if (mountedVideoId === videoId && !recreated) {
      refs.videoTitle.textContent = readTitle();
      return;
    }

    mountedVideoId = videoId;
    runId += 1;
    collapsed = false;
    refs.body.hidden = false;
    refs.toggle.textContent = "▾";
    refs.toggle.setAttribute("aria-label", "요약 패널 접기");
    refs.videoTitle.textContent = readTitle();
    restoreCache(videoId);
  }

  function ensureHost() {
    if (host?.isConnected && refs) return Promise.resolve();
    if (mounting) return mounting;

    mounting = createHost().finally(() => {
      mounting = null;
    });
    return mounting;
  }

  async function createHost() {
    if (host && !host.isConnected) {
      host = null;
      shadow = null;
      refs = null;
    }

    const anchor = getAnchor();
    if (!anchor) return;
    if (host?.isConnected && refs) return;

    if (!host) {
      host = document.createElement("div");
      host.id = "tube-digest-host";
      host.style.cssText = "display:block;width:100%;";
      shadow = host.attachShadow({ mode: "open" });
      placeHost(host, anchor);
      hostGeneration += 1;
      host.addEventListener("click", (event) => event.stopPropagation());
      host.addEventListener("mousedown", (event) => event.stopPropagation());
      host.addEventListener("keydown", (event) => event.stopPropagation());
    }

    if (!refs) await renderShell();
    applyTheme();
  }

  function getAnchor() {
    const metadata = document.querySelector("ytd-watch-flexy #below ytd-watch-metadata");
    if (metadata?.parentNode) return { parent: metadata.parentNode, before: metadata.nextSibling };
    const secondary = document.querySelector("#secondary-inner") || document.querySelector("#secondary");
    if (secondary) return { parent: secondary, before: secondary.firstChild };
    return null;
  }

  function placeHost(host, anchor) {
    const parent = anchor.parent;
    const before = anchor.before;
    if (before && before.parentNode === parent) {
      parent.insertBefore(host, before);
      return;
    }
    parent.appendChild(host);
  }

  async function renderShell() {
    if (!cssText) cssText = await loadCss();
    shadow.replaceChildren();

    const style = document.createElement("style");
    style.textContent = cssText;
    shadow.append(style);

    const card = el("section", "card");
    card.setAttribute("aria-label", "AI 요약");

    const header = el("div", "header");
    const mark = el("div", "mark");
    mark.textContent = "TD";

    const titles = el("div", "titles");
    const heading = el("h2");
    heading.textContent = "AI 요약";
    const videoTitle = el("p", "video-title");
    titles.append(heading, videoTitle);

    const settings = button("설정", "icon-button");
    settings.textContent = "⚙";
    settings.setAttribute("aria-label", "설정");
    settings.addEventListener("click", openOptions);

    const toggle = button("접기", "icon-button");
    toggle.textContent = "▾";
    toggle.setAttribute("aria-label", "요약 패널 접기");
    toggle.addEventListener("click", () => {
      collapsed = !collapsed;
      refs.body.hidden = collapsed;
      toggle.textContent = collapsed ? "▸" : "▾";
      toggle.setAttribute("aria-label", collapsed ? "요약 패널 펼치기" : "요약 패널 접기");
    });

    header.append(mark, titles, settings, toggle);

    const body = el("div", "body");
    card.append(header, body);
    shadow.append(card);

    refs = { videoTitle, body, toggle };
    renderIdle();
  }

  function renderIdle() {
    if (!refs) return;
    refs.body.replaceChildren();
    const lead = el("p", "lead");
    lead.textContent = "자막을 읽어 3줄 요약, 주요 키워드, 타임스탬프별 핵심을 만듭니다.";
    const actions = el("div", "actions");
    const summarize = button("요약하기", "primary");
    summarize.addEventListener("click", onSummarize);
    actions.append(summarize);
    refs.body.append(lead, actions);
  }

  function renderMissingKey() {
    if (!refs) return;
    refs.body.replaceChildren();
    const message = el("p", "error");
    message.textContent = "설정에서 OpenRouter API 키를 먼저 저장해 주세요.";
    const actions = el("div", "actions");
    const open = button("설정 열기", "primary");
    open.addEventListener("click", openOptions);
    actions.append(open);
    refs.body.append(message, actions);
  }

  function renderLoading(text) {
    if (!refs) return;
    refs.body.replaceChildren();
    const status = el("div", "status");
    const spinner = el("span", "spinner");
    spinner.setAttribute("aria-hidden", "true");
    const label = el("span");
    label.textContent = text;
    status.append(spinner, label);
    refs.body.append(status);
  }

  function renderError(message) {
    if (!refs) return;
    refs.body.replaceChildren();
    const text = el("p", "error");
    text.textContent = message;
    const actions = el("div", "actions");
    const retry = button("다시 시도", "primary");
    retry.addEventListener("click", onSummarize);
    const open = button("설정", "ghost");
    open.addEventListener("click", openOptions);
    actions.append(retry, open);
    refs.body.append(text, actions);
  }

  async function onSummarize() {
    const myRun = ++runId;
    const videoId = getVideoId();
    if (!videoId) return;

    const keyReady = await hasKey();
    if (myRun !== runId) return;
    if (!keyReady) {
      renderMissingKey();
      return;
    }

    renderLoading("자막을 가져오는 중…");
    try {
      const collected = await globalThis.TubeDigestTranscript.collectTranscript();
      if (stale(myRun, videoId)) return;

      renderLoading("AI가 요약을 작성하는 중…");
      const summary = await requestSummary(collected);
      if (stale(myRun, videoId)) return;

      const result = {
        ...summary,
        title: collected.title,
        language: collected.language,
        source: collected.source,
        cueCount: collected.cueCount,
        truncated: collected.truncated,
        videoId,
      };
      await saveCache(videoId, result);
      if (stale(myRun, videoId)) return;
      renderResult(result, false);
    } catch (error) {
      if (stale(myRun, videoId)) return;
      renderError(error instanceof Error ? error.message : "요약에 실패했습니다.");
    }
  }

  function renderResult(result, fromCache) {
    if (!refs) return;
    refs.body.replaceChildren();
    refs.videoTitle.textContent = result.title || readTitle();

    const parsed = parseSummary(result.markdown);
    if (!parsed.summary && !parsed.keywords && !parsed.timeline) {
      const plain = el("pre", "plain");
      plain.textContent = result.markdown.slice(0, 8000);
      refs.body.append(plain);
    } else {
      if (parsed.summary) refs.body.append(renderSummary(parsed.summary));
      if (parsed.keywords) refs.body.append(renderKeywords(parsed.keywords));
      if (parsed.timeline) refs.body.append(renderTimeline(parsed.timeline));
    }

    if (result.truncated) {
      const note = el("p", "note");
      note.textContent = "영상이 길어 자막 일부를 길이에 맞춰 균등하게 추려 요약했습니다.";
      refs.body.append(note);
    }

    const meta = el("p", "meta");
    const bits = [];
    if (fromCache) bits.push("이 탭에 저장된 요약");
    if (result.language) bits.push(`자막 ${result.language}`);
    if (SOURCE_LABEL[result.source]) bits.push(SOURCE_LABEL[result.source]);
    if (result.model) bits.push(result.model);
    meta.textContent = bits.join(" · ");

    const footer = el("div", "footer");
    const again = button(fromCache ? "다시 요약" : "새로 요약", "ghost");
    again.addEventListener("click", onSummarize);
    const copy = button("복사", "ghost");
    copy.addEventListener("click", async () => {
      const copied = await copyText(result.markdown);
      copy.textContent = copied ? "복사됨" : "복사 실패";
      setTimeout(() => {
        copy.textContent = "복사";
      }, 1400);
    });
    footer.append(again, copy);
    refs.body.append(meta, footer);
  }

  function renderSummary(text) {
    const section = el("section", "section");
    const title = el("h3");
    title.textContent = "3줄 요약";
    const list = document.createElement("ol");
    for (const line of bullets(text).slice(0, 3)) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    section.append(title, list);
    return section;
  }

  function renderKeywords(text) {
    const section = el("section", "section");
    const title = el("h3");
    title.textContent = "주요 키워드";
    const chips = el("div", "chips");
    for (const keyword of keywords(text)) {
      const chip = el("span", "chip");
      chip.textContent = keyword;
      chips.append(chip);
    }
    section.append(title, chips);
    return section;
  }

  function renderTimeline(text) {
    const section = el("section", "section");
    const title = el("h3");
    title.textContent = "타임스탬프별 핵심";
    const list = el("div", "timeline");
    const items = timeline(text);
    if (!items.length) {
      const plain = el("p", "lead");
      plain.textContent = text;
      section.append(title, plain);
      return section;
    }

    for (const item of items) {
      const row = el("div", "row");
      const time = button(item.time, "time");
      time.title = "이 시점으로 이동";
      time.addEventListener("click", () => seekTo(item.time));
      const body = el("span");
      body.textContent = item.text;
      row.append(time, body);
      list.append(row);
    }
    section.append(title, list);
    return section;
  }

  async function restoreCache(videoId) {
    renderIdle();
    try {
      const stored = await chrome.storage.session.get(CACHE_KEY);
      const cache = stored[CACHE_KEY] || {};
      const hit = cache[videoId];
      if (!hit || mountedVideoId !== videoId) return;
      renderResult(hit, true);
    } catch {
      renderIdle();
    }
  }

  async function saveCache(videoId, result) {
    try {
      const stored = await chrome.storage.session.get(CACHE_KEY);
      const cache = stored[CACHE_KEY] || {};
      cache[videoId] = result;
      const entries = Object.entries(cache).slice(-15);
      await chrome.storage.session.set({ [CACHE_KEY]: Object.fromEntries(entries) });
    } catch {
      // 세션 저장이 없어도 화면 요약은 유지합니다.
    }
  }

  function requestSummary(collected) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "SUMMARIZE",
          payload: {
            title: collected.title,
            language: collected.language,
            transcript: collected.transcript,
            truncated: collected.truncated,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "요약에 실패했습니다."));
            return;
          }
          resolve(response);
        },
      );
    });
  }

  function hasKey() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "HAS_KEY" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(Boolean(response?.hasKey));
      });
    });
  }

  function openOptions() {
    chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  }

  function seekTo(timestamp) {
    const video = document.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) return;
    video.currentTime = parseTimestamp(timestamp) / 1000;
    video.play().catch(() => {});
  }

  function parseSummary(markdown) {
    const sections = { summary: "", keywords: "", timeline: "" };
    let current = "";
    const buffers = { summary: [], keywords: [], timeline: [] };

    for (const line of String(markdown || "").split(/\r?\n/)) {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        const title = heading[1];
        if (title.includes("3줄")) current = "summary";
        else if (title.includes("키워드")) current = "keywords";
        else if (title.includes("타임") || title.includes("시간")) current = "timeline";
        else current = "";
        continue;
      }
      if (current) buffers[current].push(line);
    }

    sections.summary = buffers.summary.join("\n").trim();
    sections.keywords = buffers.keywords.join("\n").trim();
    sections.timeline = buffers.timeline.join("\n").trim();
    return sections;
  }

  function bullets(text) {
    return text
      .split(/\n+/)
      .map((line) => line.replace(/^[-*•\d.\)\s]+/, "").trim())
      .filter(Boolean);
  }

  function keywords(text) {
    return text
      .replace(/[`*]/g, "")
      .split(/[,，、\n]/)
      .map((item) => item.replace(/^[-•]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  function timeline(text) {
    const items = [];
    for (const line of text.split(/\n+/)) {
      const match = line.match(/^-?\s*\**\s*(\d{1,2}:\d{2}(?::\d{2})?)\**\s*[:\-–]?\s*(.+)$/);
      if (!match) continue;
      items.push({
        time: match[1],
        text: match[2].replace(/\*\*/g, "").trim(),
      });
    }
    return items;
  }

  function parseTimestamp(value) {
    const parts = String(value || "")
      .trim()
      .split(":")
      .map((part) => Number(part));
    if (parts.some((part) => Number.isNaN(part))) return 0;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    return 0;
  }

  async function loadCss() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_PANEL_CSS" });
      if (response?.ok && response.css) return response.css;
    } catch {
      // 아래 최소 스타일로 표시합니다.
    }
    return ":host{font-family:Arial,sans-serif}.card{padding:12px}";
  }

  function applyTheme() {
    if (!host) return;
    host.dataset.theme = document.documentElement.hasAttribute("dark") ? "dark" : "light";
  }

  function stale(myRun, videoId) {
    return myRun !== runId || getVideoId() !== videoId;
  }

  function isWatchPage() {
    return location.hostname === "www.youtube.com" && location.pathname === "/watch" && Boolean(getVideoId());
  }

  function getVideoId() {
    return new URL(location.href).searchParams.get("v") || "";
  }

  function readTitle() {
    const heading = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, ytd-watch-metadata h1");
    const text = heading?.textContent?.replace(/\s+/g, " ").trim();
    if (text) return text;
    return document.title.replace(/\s+-\s+YouTube\s*$/, "").trim();
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function button(label, className) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    return node;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    }
  }
})();
