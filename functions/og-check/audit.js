// Cloudflare Pages Function: /og-check/audit
// Fetches a target URL server-side, parses Open Graph + Twitter card meta tags
// via HTMLRewriter, and returns a structured audit (grade, issues, present-tags,
// suggested fixes).

const REQUIRED = {
  "og:title": "Open Graph title — what platforms display in the card. Without this, they fall back to <title>, which is often the wrong copy for social sharing.",
  "og:description": "Open Graph description — the line under the title in the share card.",
  "og:image": "Open Graph image — the preview thumbnail. Without it, X shows a tiny domain-only card instead of a big visual.",
  "og:url": "Open Graph canonical URL — prevents share-card duplication when the page has tracking params.",
  "og:type": "Open Graph type — usually \"website\" or \"article\".",
  "twitter:card": "Twitter card type — \"summary_large_image\" for prominent display, \"summary\" for compact.",
  "twitter:image": "Explicit Twitter image. Falls back to og:image, but explicit is safer for cross-platform consistency.",
};

const SUGGEST = {
  "og:title": (t) => `<meta property="og:title" content="${esc(t.pageTitle || "Your page title")}">`,
  "og:description": () => `<meta property="og:description" content="A clear one-sentence description of this page (max ~155 chars).">`,
  "og:image": () => `<meta property="og:image" content="https://your-domain.com/path/to/social-card.png">`,
  "og:url": (t) => `<meta property="og:url" content="${esc(t.url)}">`,
  "og:type": () => `<meta property="og:type" content="website">`,
  "twitter:card": () => `<meta name="twitter:card" content="summary_large_image">`,
  "twitter:image": (t) => `<meta name="twitter:image" content="${esc(t.tags["og:image"] || "https://your-domain.com/path/to/social-card.png")}">`,
};

function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

export async function onRequestGet({ request }) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) return json({ error: "Missing ?url= parameter." }, 400);

  let parsed;
  try {
    parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL must be http(s)");
  } catch (e) {
    return json({ error: `Invalid URL: ${e.message}` }, 400);
  }

  // Fetch with a 10s budget and a UA that identifies us honestly.
  let resp;
  try {
    resp = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OG-Check/1.0; +https://vanzackai.co.za/og-check/)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      cf: { cacheTtl: 60 },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return json({ error: `Fetch failed: ${e.message}`, target: parsed.toString() }, 502);
  }

  if (!resp.ok) {
    return json({ error: `Target returned ${resp.status} ${resp.statusText}`, target: parsed.toString() }, 502);
  }

  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("html") && !ctype.includes("xml")) {
    return json({ error: `Target is not HTML (got "${ctype || "unknown content-type"}")`, target: parsed.toString() }, 415);
  }

  // Parse meta tags + <title>.
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
      text(t) { if (inTitle) titleParts.push(t.text); if (t.lastInTextNode) inTitle = false; },
    })
    .on("link[rel='canonical']", {
      element(el) { const href = el.getAttribute("href"); if (href) tags["link:canonical"] = href; },
    });

  try {
    await rewriter.transform(resp).text();
  } catch (e) {
    return json({ error: `HTML parse failed: ${e.message}`, target: parsed.toString() }, 500);
  }

  const pageTitle = titleParts.join("").replace(/\s+/g, " ").trim();
  const audit = analyze(tags, pageTitle, parsed.toString());

  return json({
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

  // Coverage check
  for (const [key, why] of Object.entries(REQUIRED)) {
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

  // og:title vs og:description year-mismatch (the bug we caught on Omniscient).
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

  // twitter:card declares large image but no image set
  if (tags["twitter:card"] === "summary_large_image" && !tags["twitter:image"] && !tags["og:image"]) {
    issues.push({
      severity: "high",
      key: "summary_large_image-no-image",
      title: "`twitter:card=summary_large_image` declared, but no image set",
      why: "X is told to render a big-image card, but no `twitter:image` or `og:image` is provided. X falls back to a small domain-only card.",
      fix: `<meta name="twitter:image" content="https://your-domain.com/path/to/social-card.png">`,
    });
  }

  // og:image without dimensions
  if (tags["og:image"] && (!tags["og:image:width"] || !tags["og:image:height"])) {
    issues.push({
      severity: "low",
      key: "image-dimensions-missing",
      title: "`og:image:width` / `og:image:height` missing",
      why: "Some platforms make extra HEAD requests to determine image dimensions, slowing card rendering. Declaring dimensions makes cards render faster.",
      fix: `<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">`,
    });
  }

  // og:image without alt
  if (tags["og:image"] && !tags["og:image:alt"] && !tags["twitter:image:alt"]) {
    issues.push({
      severity: "low",
      key: "image-alt-missing",
      title: "Image alt text missing",
      why: "Without alt text, screen readers can't describe your share card. Inaccessible to visually impaired users.",
      fix: `<meta property="og:image:alt" content="Description of what the image shows.">`,
    });
  }

  // Title length (X displays first ~70 chars, then truncates)
  if (tags["og:title"] && tags["og:title"].length > 70) {
    issues.push({
      severity: "low",
      key: "og-title-too-long",
      title: `og:title is ${tags["og:title"].length} chars — X truncates around 70`,
      why: "Long titles get cut off mid-word in share cards. Most users see only the first ~70 characters.",
      fix: "Tighten your og:title to under 70 characters. Front-load the most important words.",
    });
  }

  // Description length
  if (tags["og:description"] && tags["og:description"].length > 200) {
    issues.push({
      severity: "low",
      key: "og-description-too-long",
      title: `og:description is ${tags["og:description"].length} chars — most platforms cap around 200`,
      why: "Long descriptions get truncated. The interesting bit at the end won't show.",
      fix: "Tighten to ~155 chars to be safe across X, LinkedIn, Slack.",
    });
  }

  // Banned marketer-speak in description (gentle nudge)
  if (tags["og:description"] && /\b(leverage|unlock|discover|revolutionize|game.changer|deep dive)\b/i.test(tags["og:description"])) {
    issues.push({
      severity: "low",
      key: "marketer-speak",
      title: "og:description uses marketer-speak words",
      why: "Words like \"leverage\", \"unlock\", \"discover\", \"revolutionize\" are noise — they don't help CTR and they signal AI slop.",
      fix: "Rewrite the description with the specific outcome the reader gets, in plain language.",
    });
  }

  // Grade from issues
  const high = issues.filter(i => i.severity === "high").length;
  const med = issues.filter(i => i.severity === "medium").length;
  const low = issues.filter(i => i.severity === "low").length;
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
