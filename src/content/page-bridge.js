(() => {
  if (globalThis.__tubeDigestBridge) return;
  globalThis.__tubeDigestBridge = true;

  const SKIP = new Set([
    "thumbnail",
    "thumbnails",
    "thumbnailOverlays",
    "storyboards",
    "playbackTracking",
    "adPlacements",
    "playerAds",
    "annotations",
    "videoDetails",
    "microformat",
    "cards",
    "endscreen",
  ]);

  const captures = [];
  let replayAttempted = false;
  hookTimedText();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== "tube-digest-content") return;

    if (message.type === "get-player") {
      replyPlayer(message.requestId);
      return;
    }

    if (message.type === "prime-captions") {
      primeCaptions(String(message.videoId || ""))
        .then((list) => reply(message.requestId, "captions", { captures: list }))
        .catch(() => reply(message.requestId, "captions", { captures: [] }));
    }
  });

  function replyPlayer(requestId) {
    const videoId = watchVideoId();
    const finish = () => reply(requestId, "player", readPlayerPayload());
    if (replayAttempted || captures.some((item) => item.videoId === videoId)) {
      finish();
      return;
    }
    replayAttempted = true;
    replayKnownCaptions(videoId).then(finish, finish);
  }

  function reply(requestId, type, payload) {
    window.postMessage(
      {
        source: "tube-digest-bridge",
        type,
        requestId,
        payload,
      },
      "*",
    );
  }

  function emptyPayload() {
    return { title: "", videoId: "", tracks: [], captures: [], innertube: null };
  }

  function readPlayerPayload() {
    let payload = emptyPayload();
    try {
      const player = readPlayerResponse();
      const tracks = readCaptionTracks(player);
      const context = readConfig("INNERTUBE_CONTEXT");
      const transcriptParams = findTranscriptParams();
      const apiKey = readConfig("INNERTUBE_API_KEY");
      const videoId = String(player?.videoDetails?.videoId || watchVideoId());

      payload = {
        title: String(player?.videoDetails?.title || ""),
        videoId,
        tracks,
        captures: publicCaptures(videoId),
        innertube:
          apiKey && context && transcriptParams
            ? {
                apiKey: String(apiKey),
                context: cloneJson(context),
                clientVersion: String(readConfig("INNERTUBE_CLIENT_VERSION") || ""),
                clientName: String(readConfig("INNERTUBE_CONTEXT_CLIENT_NAME") || "1"),
                transcriptParams: String(transcriptParams),
              }
            : null,
      };
    } catch {
      payload = emptyPayload();
      payload.captures = publicCaptures(watchVideoId());
    }
    return payload;
  }

  function hookTimedText() {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (input, init) {
        const url = requestUrl(input);
        const pending = originalFetch.apply(this, arguments);
        if (!isTimedTextUrl(url)) return pending;
        return Promise.resolve(pending).then((response) => {
          try {
            response
              .clone()
              .text()
              .then((body) => rememberTimedText(url, body))
              .catch(() => {});
          } catch {
            // 응답 본문을 복제할 수 없어도 재생기의 요청은 그대로 둡니다.
          }
          return response;
        });
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__tubeDigestUrl = url;
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener("load", () => {
        try {
          const url = this.__tubeDigestUrl;
          if (!isTimedTextUrl(url)) return;
          if (!this.responseType || this.responseType === "text") {
            rememberTimedText(url, this.responseText);
            return;
          }
          if (this.responseType === "json" && this.response) {
            rememberTimedText(url, JSON.stringify(this.response));
          }
        } catch {
          // 자막이 아닌 응답은 무시합니다.
        }
      });
      return originalSend.apply(this, arguments);
    };
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isTimedTextUrl(value) {
    try {
      const url = new URL(String(value), location.href);
      return url.protocol === "https:" && /(^|\.)youtube\.com$/i.test(url.hostname) && url.pathname === "/api/timedtext";
    } catch {
      return false;
    }
  }

  function rememberTimedText(rawUrl, body) {
    if (typeof body !== "string" || body.trim().length < 40) return;
    let url;
    try {
      url = new URL(String(rawUrl), location.href);
    } catch {
      return;
    }
    const videoId = url.searchParams.get("v") || "";
    if (!videoId) return;
    const language = url.searchParams.get("tlang") || url.searchParams.get("lang") || "";
    const entry = {
      videoId,
      language,
      kind: url.searchParams.get("kind") || "",
      translated: url.searchParams.has("tlang"),
      body: body.length > 500000 ? body.slice(0, 500000) : body,
      at: Date.now(),
    };
    const index = captures.findIndex(
      (item) => item.videoId === videoId && item.language === language && item.translated === entry.translated,
    );
    if (index >= 0) captures.splice(index, 1);
    captures.push(entry);
    while (captures.length > 8) captures.shift();
  }

  function publicCaptures(videoId) {
    return captures
      .filter((item) => item.videoId === videoId)
      .map((item) => ({
        videoId: item.videoId,
        language: item.language,
        kind: item.kind,
        translated: item.translated,
        body: item.body,
      }));
  }

  async function replayKnownCaptions(videoId) {
    if (!videoId) return;
    const names = [];
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const name = String(entry?.name || "");
        if (!name.includes("pot=") || !isTimedTextUrl(name)) continue;
        const url = new URL(name);
        if (url.searchParams.get("v") !== videoId) continue;
        names.push(name);
      }
    } catch {
      return;
    }

    for (const name of names.slice(-3)) {
      try {
        const response = await fetch(name, { credentials: "include" });
        rememberTimedText(name, await response.text());
      } catch {
        // 다음 자막 주소로 넘어갑니다.
      }
    }
  }

  async function primeCaptions(expectedId) {
    const videoId = expectedId || watchVideoId();
    await replayKnownCaptions(videoId);
    if (captures.some((item) => item.videoId === videoId)) return publicCaptures(videoId);

    const player = await waitForPlayer(6000);
    if (!player || !videoId) return publicCaptures(videoId);

    const startedAt = Date.now();
    let wasOn = false;
    try {
      const loaded = player.loadModule?.("captions");
      if (loaded && typeof loaded.then === "function") await loaded;
    } catch {
      // 자막 모듈이 이미 올라와 있으면 그대로 진행합니다.
    }

    try {
      wasOn = Boolean(player.isSubtitlesOn?.());
    } catch {
      wasOn = false;
    }

    const tracks = await waitForTracklist(player, 6000);
    const chosen = pickTrack(tracks);

    try {
      if (chosen) player.setOption?.("captions", "track", chosen);
      if (wasOn) {
        player.toggleSubtitles?.();
        await wait(250);
      }
      if (typeof player.toggleSubtitlesOn === "function") player.toggleSubtitlesOn();
      else player.toggleSubtitles?.();
      if (chosen) player.setOption?.("captions", "track", chosen);
      const found = await waitForNewCapture(videoId, startedAt, 8000);
      if (found) await wait(1200);
    } catch {
      // 재생기 조작이 실패해도 이미 받아 둔 자막이 있으면 그걸 씁니다.
    } finally {
      restoreSubtitles(player, wasOn);
    }

    return publicCaptures(videoId);
  }

  function restoreSubtitles(player, wasOn) {
    try {
      const on = Boolean(player.isSubtitlesOn?.());
      if (wasOn && !on) player.toggleSubtitlesOn?.();
      if (!wasOn && on) player.toggleSubtitles?.();
    } catch {
      // 원래 자막 상태로 되돌리지 못해도 본문 수집은 계속합니다.
    }
  }

  function waitForPlayer(timeoutMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const player = playerElement();
        if (player || Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(player);
        }
      }, 200);
    });
  }

  function playerElement() {
    const node = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    if (node && (node.getPlayerResponse || node.toggleSubtitlesOn || node.getOption)) return node;
    return null;
  }

  function waitForTracklist(player, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        let list = [];
        try {
          const value = player.getOption?.("captions", "tracklist");
          if (Array.isArray(value)) list = value;
        } catch {
          list = [];
        }
        if (list.length || Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(list);
        }
      }, 300);
    });
  }

  function pickTrack(tracks) {
    const usable = tracks.filter((track) => track && track.languageCode);
    if (!usable.length) return null;
    return [...usable].sort((left, right) => scoreLanguage(right) - scoreLanguage(left))[0];
  }

  function scoreLanguage(track) {
    const language = String(track.languageCode || "").toLowerCase();
    let score = 0;
    if (language.startsWith("ko")) score += 100;
    else if (language.startsWith("en")) score += 50;
    else score += 10;
    if (track.kind !== "asr") score += 5;
    return score;
  }

  function waitForNewCapture(videoId, since, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const hit = captures.some((item) => item.videoId === videoId && item.at >= since);
        if (hit || Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(hit);
        }
      }, 200);
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function watchVideoId() {
    try {
      return new URL(location.href).searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function readPlayerResponse() {
    const live = readLivePlayerResponse();
    if (live?.videoDetails?.videoId) return live;

    const current = globalThis.ytInitialPlayerResponse;
    if (current?.captions || current?.videoDetails) return current;

    for (const script of document.scripts) {
      const text = script.textContent || "";
      const marker = text.indexOf("ytInitialPlayerResponse");
      if (marker === -1) continue;
      const start = text.indexOf("{", marker);
      if (start === -1) continue;
      const json = extractJsonObject(text, start);
      if (!json) continue;
      try {
        return JSON.parse(json);
      } catch {
        continue;
      }
    }

    return null;
  }

  function readLivePlayerResponse() {
    const player = playerElement();
    if (typeof player?.getPlayerResponse !== "function") return null;
    try {
      const data = player.getPlayerResponse();
      if (data?.videoDetails?.videoId) return data;
    } catch {
      return null;
    }
    return null;
  }

  function extractJsonObject(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }

    return null;
  }

  function readCaptionTracks(player) {
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return tracks
      .map((track) => ({
        baseUrl: String(track.baseUrl || ""),
        languageCode: String(track.languageCode || ""),
        kind: String(track.kind || ""),
        name: String(track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode || ""),
      }))
      .filter((track) => track.baseUrl.startsWith("http"));
  }

  function readConfig(key) {
    try {
      if (typeof globalThis.ytcfg?.get === "function") return globalThis.ytcfg.get(key);
    } catch {
      return globalThis.ytcfg?.data_?.[key] ?? null;
    }
    return globalThis.ytcfg?.data_?.[key] ?? null;
  }

  function findTranscriptParams() {
    const data = globalThis.ytInitialData;
    if (!data) return null;

    const roots = [];
    if (data.engagementPanels) roots.push(data.engagementPanels);
    const contents = data.contents?.twoColumnWatchNextResults?.results?.results?.contents;
    if (contents) roots.push(contents);

    for (const root of roots) {
      const params = deepFindParams(root, 0, { visits: 0 });
      if (params) return params;
    }
    return null;
  }

  function deepFindParams(node, depth, state) {
    if (!node || typeof node !== "object" || depth > 12 || state.visits > 8000) return null;
    state.visits += 1;

    if (typeof node.getTranscriptEndpoint?.params === "string") {
      return node.getTranscriptEndpoint.params;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = deepFindParams(item, depth + 1, state);
        if (found) return found;
      }
      return null;
    }

    for (const [key, value] of Object.entries(node)) {
      if (SKIP.has(key)) continue;
      const found = deepFindParams(value, depth + 1, state);
      if (found) return found;
    }
    return null;
  }

  function cloneJson(value) {
    try {
      return structuredClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return null;
      }
    }
  }
})();
