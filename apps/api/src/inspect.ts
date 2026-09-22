import { buildPageReport, type PageReport } from "@spectra/evaluation";
import { fetchPublic } from "./net";
import { isHtml, probe, probeBots, readPage } from "./scan";

export class InspectError extends Error {}

/**
 * One URL, fetched the way an AI crawler fetches it: no JavaScript, raw HTML,
 * robots.txt read for this exact path, and a live request as each crawler so
 * a firewall that refuses them shows up as the refusal it is.
 */
export async function inspectUrl(
  raw: string,
  question = "",
): Promise<PageReport> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new InspectError("Enter a valid public URL.");
  }
  const [page, robots, probes] = await Promise.all([
    fetchPublic(url).catch((error) => {
      throw new InspectError(
        `Could not fetch ${url.href}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }),
    probe(new URL("/robots.txt", url), "text/plain,*/*;q=0.1"),
    probeBots(url),
  ]);
  if (!isHtml(page))
    throw new InspectError(
      page.status >= 400
        ? `${url.href} answered ${page.status}. An AI crawler gets the same refusal.`
        : `${url.href} is not an HTML page (${page.headers.get("content-type") || "no content type"}).`,
    );
  return buildPageReport({
    page: readPage(page),
    // No robots.txt at all means everything is allowed; one that could not be
    // read is treated the same way, and the report shows which it was.
    robotsText: robots.status === 200 ? robots.body : null,
    probes,
    question,
  });
}
