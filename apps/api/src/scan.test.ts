import { describe, expect, it } from "vitest";
import { readPage } from "./scan";

function read(body: string) {
  return readPage({
    url: "https://acme.test/",
    status: 200,
    ms: 10,
    bytes: body.length,
    body,
    headers: new Headers({ "content-type": "text/html" }),
  });
}

describe("readPage structure", () => {
  it("reads paragraphs, lists and tables from the main content only", () => {
    const page = read(`<html><body>
      <nav><p>Home about pricing blog careers contact us today now</p><ul><li>a</li><li>b</li></ul></nav>
      <main>
        <p>Short.</p>
        <p>Acme Ledger is an invoicing tool for freelancers and small studios.</p>
        <ul><li>Send</li><li>Chase</li></ul>
        <ol><li>Only one</li></ol>
        <table><tr><td>Plan</td></tr><tr><td>$12</td></tr></table>
        <p>It reconciles bank feeds every night and flags anything that does not match.</p>
      </main>
    </body></html>`);
    expect(page.structureRead).toBe(true);
    expect(page.lead).toBe(
      "Acme Ledger is an invoicing tool for freelancers and small studios.",
    );
    expect(page.passages).toHaveLength(2);
    expect(page.lists).toBe(1);
    expect(page.tables).toBe(1);
  });

  it("reads copy set in bare divs, once, where the text actually sits", () => {
    const page = read(`<html><body><main>
      <div class="hero"><div>Acme Ledger is the invoicing tool built for freelancers and studios.</div>
      <div><span>Send invoices, chase late payments and reconcile bank feeds nightly.</span></div></div>
    </main></body></html>`);
    expect(page.passages).toEqual([
      "Acme Ledger is the invoicing tool built for freelancers and studios.",
      "Send invoices, chase late payments and reconcile bank feeds nightly.",
    ]);
  });

  it("keeps words in adjacent blocks apart", () => {
    const page = read(
      "<html><body><main><div>Free</div><div>Unlimited members</div><p>Line one<br>line two</p></main></body></html>",
    );
    expect(page.excerpt).toBe("Free Unlimited members Line one line two");
  });

  it("falls back to the body when the page marks no main content", () => {
    const page = read(
      "<html><body><p>Acme Ledger sends invoices and chases late payments for you.</p></body></html>",
    );
    expect(page.passages).toHaveLength(1);
    expect(page.lists).toBe(0);
  });
});
