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

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== "tube-digest-content" || message.type !== "get-player") return;

    let payload = emptyPayload();
    try {
      payload = readPlayerPayload();
    } catch {
      payload = emptyPayload();
    }

    window.postMessage(
      {
        source: "tube-digest-bridge",
        type: "player",
        requestId: message.requestId,
        payload,
      },
      "*",
    );
  });

  function emptyPayload() {
    return { title: "", videoId: "", tracks: [], innertube: null };
  }

  function readPlayerPayload() {
    const player = readPlayerResponse();
    const tracks = readCaptionTracks(player);
    const context = readConfig("INNERTUBE_CONTEXT");
    const transcriptParams = findTranscriptParams();
    const apiKey = readConfig("INNERTUBE_API_KEY");

    return {
      title: String(player?.videoDetails?.title || ""),
      videoId: String(player?.videoDetails?.videoId || ""),
      tracks,
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
  }

  function readPlayerResponse() {
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
