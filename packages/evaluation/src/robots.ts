export type Robots = {
  rules: Array<{ allow: boolean; path: string }>;
  sitemaps: string[];
};

/**
 * RFC 9309 group matching. The previous implementation treated any
 * `Disallow: /` line as a site-wide block, so one hostile-bot rule locked
 * SPECTRA out of sites it was welcome to read, and per-path rules were ignored
 * entirely in the other direction.
 */
export function parseRobots(text: string, token = "spectra"): Robots {
  const sitemaps: string[] = [];
  const groups: Array<{ agents: string[]; rules: Robots["rules"] }> = [];
  let current: { agents: string[]; rules: Robots["rules"] } | null = null;
  let previousWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !previousWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }
    if (field !== "allow" && field !== "disallow") continue;
    previousWasAgent = false;
    if (!current) continue;
    current.rules.push({ allow: field === "allow", path: value });
  }
  const exact = groups.filter((group) =>
    group.agents.includes(token.toLowerCase()),
  );
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  const chosen = exact.length ? exact : wildcard;
  return { rules: chosen.flatMap((group) => group.rules), sitemaps };
}

export function isAllowed(robots: Robots, url: URL): boolean {
  const path = `${url.pathname}${url.search}`;
  let decision: { allow: boolean; length: number } | null = null;
  for (const rule of robots.rules) {
    // An empty Disallow value means "allow everything" and carries no path.
    if (!rule.path) continue;
    if (!matchesRobotsPath(rule.path, path)) continue;
    const length = rule.path.length;
    // Longest match wins; Allow wins ties, per RFC 9309.
    if (
      !decision ||
      length > decision.length ||
      (length === decision.length && rule.allow)
    )
      decision = { allow: rule.allow, length };
  }
  return decision ? decision.allow : true;
}

function matchesRobotsPath(pattern: string, path: string): boolean {
  const mustEnd = pattern.endsWith("$");
  const body = mustEnd ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");
  let index = 0;
  for (const [position, segment] of segments.entries()) {
    if (!segment) continue;
    if (position === 0) {
      if (!path.startsWith(segment)) return false;
      index = segment.length;
      continue;
    }
    const found = path.indexOf(segment, index);
    if (found < 0) return false;
    index = found + segment.length;
  }
  if (mustEnd) {
    const last = segments[segments.length - 1];
    return segments.length === 1 ? path === body : path.endsWith(last);
  }
  return true;
}
