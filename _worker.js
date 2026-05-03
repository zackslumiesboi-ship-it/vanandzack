// Cloudflare Worker entrypoint for vanandzack.
//
// Architecture: Workers + Static Assets. The ASSETS binding (auto-injected by
// the Workers Static Assets runtime) serves the static HTML/CSS/PNG files in
// this repo. This script intercepts dynamic API routes BEFORE the static
// fallback. Add new API routes here.
//
// Routes:
//   GET /og-check/audit?url=<URL>  -> JSON OG/Twitter card audit
//   *                              -> static asset fallback (env.ASSETS)

const REQUIRED_TAGS = {
  "og:title": "Open Graph title — what platforms display in the card. Without this, they fall back to <title>, which is often the wrong copy for social sharing.",
  "og:description": "Open Graph description — the line under the title in the share card.",
  "og:image": "Open Graph image — the preview thumbnail. Without it, X shows a tiny domain-only card instead of a big visual.",
  "og:url": "Open Graph canonical URL — prevents share-card duplication when the page has tracking params.",
  "og:type": "Open Graph type — usually \"website\" or \"article\".",
  "twitter:card": "Twitter card type — \"summary_large_image\" for prominent display, \"summary\" for compact.",
  "twitter:image": "Explicit Twitter image. Falls back to og:image, but explicit is safer for cross-platform consistency.",
};

const SUGGEST = {
  "og:title": (ctx) => `<meta property="og:title" content="${esc(ctx.pageTitle || "Your page title")}">`,
  "og:description": () => `<meta property="og:description" content="A clear one-sentence description of this page (max ~155 chars).">`,
  "og:image": () => `<meta property="og:image" content="https://your-domain.com/path/to/social-card.png">`,
  "og:url": (ctx) => `<meta property="og:url" content="${esc(ctx.url)}">`,
  "og:type": () => `<meta property="og:type" content="website">`,
  "twitter:card": () => `<meta name="twitter:card" content="summary_large_image">`,
  "twitter:image": (ctx) => `<meta name="twitter:image" content="${esc(ctx.tags["og:image"] || "https://your-domain.com/path/to/social-card.png")}">`,
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

async function handleAudit(request) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) return jsonResponse({ error: "Missing ?url= parameter." }, 400);

  let parsed;
  try {
    parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("URL must be http(s)");
    }
  } catch (e) {
    return jsonResponse({ error: `Invalid URL: ${e.message}` }, 400);
  }

  let resp;
  try {
    resp = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OG-Check/1.0; +https://vanzackai.co.za/og-check/)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      cf: { cacheTtl: 60 },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return jsonResponse({ error: `Fetch failed: ${e.message}`, target: parsed.toString() }, 502);
  }

  if (!resp.ok) {
    return jsonResponse(
      { error: `Target returned ${resp.status} ${resp.statusText}`, target: parsed.toString() },
      502
    );
  }

  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("html") && !ctype.includes("xml")) {
    return jsonResponse(
      { error: `Target is not HTML (got "${ctype || "unknown content-type"}")`, target: parsed.toString() },
      415
    );
  }

  const tags = {};
  const titleParts = [];
  let inTitle = false;

  const rewriter = new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = el.getAttribute("property") || el.getAttribute("name");
        const value = el.getAttribute("content");
        if (key && value) tags[key.toLowerCase()] = value;
      },
    })
    .on("title", {
      element() { inTitle = true; },
      text(t) {
        if (inTitle) titleParts.push(t.text);
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .on("link[rel='canonical']", {
      element(el) {
        const href = el.getAttribute("href");
        if (href) tags["link:canonical"] = href;
      },
    });

  try {
    await rewriter.transform(resp).text();
  } catch (e) {
    return jsonResponse({ error: `HTML parse failed: ${e.message}`, target: parsed.toString() }, 500);
  }

  const pageTitle = titleParts.join("").replace(/\s+/g, " ").trim();
  const audit = analyze(tags, pageTitle, parsed.toString());

  return jsonResponse({
    target: parsed.toString(),
    pageTitle,
    finalUrl: resp.url,
    tags,
    audit,
  });
}

function analyze(tags, pageTitle, url) {
  const ctx = { tags, pageTitle, url };
  const issues = [];
  const present = [];

  for (const [key, why] of Object.entries(REQUIRED_TAGS)) {
    if (tags[key]) {
      present.push({ key, value: tags[key] });
    } else {
      issues.push({
        severity: "high",
        key,
        title: `Missing \`${key}\``,
        why,
        fix: SUGGEST[key](ctx),
      });
    }
  }

  if (tags["og:title"] && tags["og:description"]) {
    const yr = /\b(20\d{2})\b/;
    const t = (tags["og:title"].match(yr) || [])[1];
    const d = (tags["og:description"].match(yr) || [])[1];
    if (t && d && t !== d) {
      issues.push({
        severity: "medium",
        key: "year-mismatch",
        title: `Year mismatch: og:title says ${t}, og:description says ${d}`,
        why: "Your share card displays two different years on the same card. Common when one tag was refreshed and the other was missed.",
        fix: `Pick one year and update both \`og:title\` and \`og:description\` to match.`,
      });
    }
  }

  if (tags["twitter:card"] === "summary_large_image" && !tags["twitter:image"] && !tags["og:image"]) {
    issues.push({
      severity: "high",
      key: "summary_large_image-no-image",
      title: "`twitter:card=summary_large_image` declared, but no image set",
      why: "X is told to render a big-image card, but no `twitter:image` or `og:image` is provided. X falls back to a small domain-only card.",
      fix: `<meta name="twitter:image" content="https://your-domain.com/path/to/social-card.png">`,
    });
  }

  if (tags["og:image"] && (!tags["og:image:width"] || !tags["og:image:height"])) {
    issues.push({
      severity: "low",
      key: "image-dimensions-missing",
      title: "`og:image:width` / `og:image:height` missing",
      why: "Some platforms make extra HEAD requests to determine image dimensions, slowing card rendering. Declaring dimensions makes cards render faster.",
      fix: `<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">`,
    });
  }

  if (tags["og:image"] && !tags["og:image:alt"] && !tags["twitter:image:alt"]) {
    issues.push({
      severity: "low",
      key: "image-alt-missing",
      title: "Image alt text missing",
      why: "Without alt text, screen readers can't describe your share card. Inaccessible to visually impaired users.",
      fix: `<meta property="og:image:alt" content="Description of what the image shows.">`,
    });
  }

  if (tags["og:title"] && tags["og:title"].length > 70) {
    issues.push({
      severity: "low",
      key: "og-title-too-long",
      title: `og:title is ${tags["og:title"].length} chars — X truncates around 70`,
      why: "Long titles get cut off mid-word in share cards. Most users see only the first ~70 characters.",
      fix: "Tighten your og:title to under 70 characters. Front-load the most important words.",
    });
  }

  if (tags["og:description"] && tags["og:description"].length > 200) {
    issues.push({
      severity: "low",
      key: "og-description-too-long",
      title: `og:description is ${tags["og:description"].length} chars — most platforms cap around 200`,
      why: "Long descriptions get truncated. The interesting bit at the end won't show.",
      fix: "Tighten to ~155 chars to be safe across X, LinkedIn, Slack.",
    });
  }

  if (tags["og:description"] && /\b(leverage|unlock|discover|revolutionize|game.changer|deep dive)\b/i.test(tags["og:description"])) {
    issues.push({
      severity: "low",
      key: "marketer-speak",
      title: "og:description uses marketer-speak words",
      why: "Words like \"leverage\", \"unlock\", \"discover\", \"revolutionize\" are noise — they don't help CTR and they signal AI slop.",
      fix: "Rewrite the description with the specific outcome the reader gets, in plain language.",
    });
  }

  const high = issues.filter((i) => i.severity === "high").length;
  const med = issues.filter((i) => i.severity === "medium").length;
  const low = issues.filter((i) => i.severity === "low").length;
  let grade;
  if (high === 0 && med === 0 && low === 0) grade = "A";
  else if (high === 0 && med === 0) grade = "B";
  else if (high === 0) grade = "C";
  else if (high <= 2) grade = "D";
  else grade = "F";

  return {
    grade,
    counts: { high, medium: med, low },
    summary: `${present.length} core tag${present.length === 1 ? "" : "s"} present, ${issues.length} issue${issues.length === 1 ? "" : "s"} found`,
    issues,
    present,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/og-check/audit" && request.method === "GET") {
      return handleAudit(request);
    }

    // Fall through to static assets (HTML, CSS, images, etc.)
    return env.ASSETS.fetch(request);
  },
};
