/**
 * Whether the runtime carries the Node.js security release of 21 October 2026
 * (CVE-2026-111497, Brotli decoder out-of-bounds write, and nine more: TLS
 * hostname bypasses, dns NUL truncation, keep-alive response desync).
 *
 * The crawler no longer decodes Brotli at all (see net.ts), so the worst of
 * these is closed whatever this says. The rest live in the runtime itself and
 * are fixed only by running a patched Node, which on Vercel is the platform's
 * job; this makes it checkable instead of assumed.
 */
const FIXED: Record<number, [number, number]> = {
  22: [23, 4],
  24: [22, 1],
  26: [12, 1],
};

/** True when patched, false when not, null when this is not Node at all. */
export function runtimePatched(
  version = process.version,
  versions: Record<string, string | undefined> = process.versions,
): boolean | null {
  // Bun and Deno report a Node version they emulate, not one they run.
  if (versions.bun || versions.deno) return null;
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major > 26) return true;
  const fixed = FIXED[major];
  // Odd and older lines are end of life: they never receive this fix.
  if (!fixed) return false;
  return minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1]);
}

export const FIXED_VERSIONS = "22.23.4, 24.22.1 or 26.12.1";
