(() => {
  const MAX_CHARS = 14000;
  const NOISE = /^(music|applause|laughter|음악|박수|박수 소리|웃음|\[music\]|\[applause\]|\[laughter\])$/i;

  function collectTranscript() {
    return gather();
  }

  async function gather() {
    const videoId = currentVideoId();
    if (!videoId) throw new Error("영상 주소를 확인하지 못했습니다.");

    const player = await requestPlayer(videoId);
    const title = player?.title || readDomTitle();
    const orderedTracks = rankTracks(player?.tracks || []);

    if (orderedTracks.length) {
      const fromTracks = await loadTracks(orderedTracks);
      if (fromTracks) return pack(fromTracks.cues, title, fromTracks.language, "timedtext");
    }

    const innertube = player?.innertube;
    if (innertube?.apiKey && innertube.context && innertube.transcriptParams) {
      try {
        const cues = await loadInnertube(innertube);
        if (usable(cues)) {
          return pack(cues, title, orderedTracks[0]?.languageCode || "", "innertube");
        }
      } catch {
        // DOM 추출로 넘어갑니다.
      }
    }

    const domCues = await loadDom();
    if (usable(domCues)) return pack(domCues, title, "", "dom");

    throw new Error(
      "이 영상에서 자막을 찾지 못했습니다. 자막이 제공되는 영상인지 확인한 뒤 다시 시도해 주세요.",
    );
  }

  function pack(cues, title, language, source) {
    const cleaned = chunkCues(prepareCues(cues));
    if (!usable(cleaned)) {
      throw new Error("자막 텍스트가 거의 없습니다. 다른 영상을 시도해 주세요.");
    }

    const fitted = fitCues(cleaned);
    return {
      title,
      language: language || "알 수 없음",
      source,
      cueCount: cleaned.length,
      truncated: fitted.truncated,
      transcript: fitted.text,
    };
  }

  function usable(cues) {
    const text = cues.map((cue) => cue.text).join(" ").trim();
    return cues.length > 0 && text.length >= 10;
  }

  async function requestPlayer(expectedId) {
    let last = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      last = await requestPlayerOnce();
      const matches = !last?.videoId || last.videoId === expectedId;
      const ready = last?.tracks?.length || last?.innertube?.transcriptParams;
      if (matches && ready) return last;
      await wait(350);
    }
    return last;
  }

  function requestPlayerOnce() {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 2000);

      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "tube-digest-bridge" || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(data.payload || null);
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ source: "tube-digest-content", type: "get-player", requestId }, "*");
    });
  }

  function rankTracks(tracks) {
    return [...tracks].sort((left, right) => scoreTrack(right) - scoreTrack(left));
  }

  function scoreTrack(track) {
    const language = String(track.languageCode || "").toLowerCase();
    let score = 0;
    if (language.startsWith("ko")) score += 100;
    else if (language.startsWith("en")) score += 50;
    else score += 10;
    if (track.kind !== "asr") score += 5;
    return score;
  }

  async function loadTracks(tracks) {
    for (const track of tracks.slice(0, 3)) {
      try {
        const cues = await fetchTrack(track);
        if (usable(cues)) return { cues, language: track.languageCode || "" };
      } catch {
        continue;
      }
    }
    return null;
  }

  async function fetchTrack(track) {
    const original = new URL(track.baseUrl, location.origin);
    const withJson = new URL(original.toString());
    if (!withJson.searchParams.has("fmt")) withJson.searchParams.set("fmt", "json3");

    try {
      const jsonCues = await fetchCaptionBody(withJson);
      if (jsonCues.length) return jsonCues;
    } catch {
      if (withJson.toString() === original.toString()) throw new Error("caption failed");
    }
    if (withJson.toString() === original.toString()) return [];
    return fetchCaptionBody(original);
  }

  async function fetchCaptionBody(url) {
    const response = await fetchWithTimeout(url.toString(), { credentials: "include" }, 15000);
    if (!response.ok) throw new Error(`caption ${response.status}`);
    const body = await response.text();
    return parseCaptionBody(body);
  }

  async function loadInnertube(innertube) {
    const endpoint = new URL("https://www.youtube.com/youtubei/v1/get_transcript");
    endpoint.searchParams.set("prettyPrint", "false");
    endpoint.searchParams.set("key", innertube.apiKey);

    const headers = { "Content-Type": "application/json" };
    if (innertube.clientName) headers["X-YouTube-Client-Name"] = innertube.clientName;
    if (innertube.clientVersion) headers["X-YouTube-Client-Version"] = innertube.clientVersion;

    const response = await fetchWithTimeout(
      endpoint.toString(),
      {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          context: innertube.context,
          params: innertube.transcriptParams,
        }),
      },
      15000,
    );
    if (!response.ok) throw new Error(`transcript ${response.status}`);
    const data = await response.json();
    return prepareCues(collectSegments(data));
  }

  function collectSegments(node, out = []) {
    if (!node || typeof node !== "object") return out;
    if (node.transcriptSegmentRenderer) {
      const segment = node.transcriptSegmentRenderer;
      const text = (segment.snippet?.runs || [])
        .map((run) => run.text || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      const startMs = Number(segment.startMs || segment.startTimeMs || 0);
      if (text) out.push({ startMs: Number.isFinite(startMs) ? startMs : 0, text });
      return out;
    }

    const values = Array.isArray(node) ? node : Object.values(node);
    for (const value of values) collectSegments(value, out);
    return out;
  }

  async function loadDom() {
    let cues = readDomSegments();
    if (cues.length >= 3) return cues;

    expandDescription();
    await wait(300);
    cues = readDomSegments();
    if (cues.length >= 3) return cues;

    const button = findTranscriptButton();
    if (!button) return cues;
    button.click();
    return waitForSegments();
  }

  function expandDescription() {
    const expand = document.querySelector("ytd-text-inline-expander #expand, tp-yt-paper-button#expand");
    if (!(expand instanceof HTMLElement)) return;
    if (expand.hidden || expand.getAttribute("hidden") !== null) return;
    expand.click();
  }

  function findTranscriptButton() {
    const scoped = document.querySelector(
      "ytd-video-description-transcript-section-renderer button, ytd-video-description-transcript-section-renderer yt-button-shape button",
    );
    if (scoped) return scoped;

    const candidates = document.querySelectorAll("#description button, ytd-watch-metadata button, #below button");
    for (const button of candidates) {
      const label = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.replace(/\s+/g, " ").trim();
      if (!label || label.length > 48) continue;
      if (/show transcript|open transcript|transcript|스크립트|대본/i.test(label)) return button;
    }
    return null;
  }

  function readDomSegments() {
    const cues = [];
    document.querySelectorAll("ytd-transcript-segment-renderer").forEach((node) => {
      const timeText = node.querySelector(".segment-timestamp, [class*='timestamp']")?.textContent || "";
      const text = (node.querySelector(".segment-text, yt-formatted-string")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      cues.push({ startMs: parseTimestamp(timeText), text });
    });
    return prepareCues(cues);
  }

  async function waitForSegments() {
    const started = Date.now();
    let latest = [];
    while (Date.now() - started < 5000) {
      latest = readDomSegments();
      if (latest.length >= 3) return latest;
      await wait(200);
    }
    return latest;
  }

  function parseCaptionBody(body) {
    const trimmed = body.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return parseJson3(JSON.parse(trimmed));
      } catch {
        return [];
      }
    }
    if (trimmed.startsWith("<")) return parseTimedTextXml(trimmed);
    return [];
  }

  function parseJson3(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    const cues = [];
    let lastStart = 0;
    for (const event of events) {
      if (typeof event?.tStartMs === "number") lastStart = event.tStartMs;
      if (!Array.isArray(event?.segs)) continue;
      const text = event.segs
        .map((segment) => segment.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      cues.push({ startMs: lastStart, text });
    }
    return cues;
  }

  function parseTimedTextXml(xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.querySelector("parsererror")) return [];
    return [...doc.getElementsByTagName("text")].map((node) => ({
      startMs: Math.round(Number(node.getAttribute("start") || 0) * 1000),
      text: (node.textContent || "").replace(/\s+/g, " ").trim(),
    }));
  }

  function prepareCues(cues) {
    const sorted = [...cues]
      .filter((cue) => cue && typeof cue.text === "string")
      .map((cue) => ({
        startMs: Math.max(0, Number(cue.startMs) || 0),
        text: cue.text.replace(/\s+/g, " ").trim(),
      }))
      .filter((cue) => cue.text && !NOISE.test(cue.text))
      .sort((left, right) => left.startMs - right.startMs);

    const deduped = [];
    for (const cue of sorted) {
      const previous = deduped[deduped.length - 1];
      if (previous && previous.text === cue.text && Math.abs(previous.startMs - cue.startMs) < 800) continue;
      deduped.push(cue);
    }
    return deduped;
  }

  function chunkCues(cues) {
    const chunks = [];
    let current = null;
    for (const cue of cues) {
      if (!current) {
        current = { startMs: cue.startMs, text: cue.text };
        continue;
      }
      const joined = `${current.text} ${cue.text}`;
      if (joined.length > 180) {
        chunks.push(current);
        current = { startMs: cue.startMs, text: cue.text };
      } else {
        current.text = joined;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function fitCues(cues) {
    if (serialize(cues).length <= MAX_CHARS) {
      return { text: serialize(cues), truncated: false };
    }

    let best = [cues[0]];
    let low = 1;
    let high = cues.length;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const sampled = sampleEven(cues, mid);
      if (serialize(sampled).length <= MAX_CHARS) {
        best = sampled;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return { text: serialize(best), truncated: true };
  }

  function sampleEven(cues, count) {
    if (count >= cues.length) return cues;
    if (count <= 1) return [cues[0]];
    const sampled = [];
    for (let index = 0; index < count; index += 1) {
      const cueIndex = Math.round((index * (cues.length - 1)) / (count - 1));
      sampled.push(cues[cueIndex]);
    }
    return sampled;
  }

  function serialize(cues) {
    return cues.map((cue) => `[${formatTime(cue.startMs)}] ${cue.text}`).join("\n");
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (value) => String(value).padStart(2, "0");
    if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    return `${minutes}:${pad(seconds)}`;
  }

  function parseTimestamp(value) {
    const parts = String(value || "")
      .trim()
      .split(":")
      .map((part) => Number(part));
    if (!parts.length || parts.some((part) => Number.isNaN(part))) return 0;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    return parts[0] * 1000;
  }

  function readDomTitle() {
    const heading = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, ytd-watch-metadata h1");
    const text = heading?.textContent?.replace(/\s+/g, " ").trim();
    if (text) return text;
    return document.title.replace(/\s+-\s+YouTube\s*$/, "").trim();
  }

  function currentVideoId() {
    return new URL(location.href).searchParams.get("v") || "";
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  globalThis.TubeDigestTranscript = { collectTranscript };
})();
