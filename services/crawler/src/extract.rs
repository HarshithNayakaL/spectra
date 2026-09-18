use scraper::node::Node;
use scraper::{ElementRef, Html, Selector};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use url::Url;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SemanticElement {
    pub tag: String,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub url: Url,
    pub status: u16,
    pub title: String,
    pub description: String,
    pub canonical_url: Option<Url>,
    pub headings: Vec<Heading>,
    pub text: String,
    pub links: Vec<Url>,
    pub json_ld: Vec<Value>,
    pub open_graph: BTreeMap<String, String>,
    pub twitter: BTreeMap<String, String>,
    pub semantic_elements: Vec<SemanticElement>,
    pub fingerprint: String,
    pub content_type: String,
    pub duplicate_of: Option<String>,
}

pub fn extract(url: Url, status: u16, content_type: String, html: &str) -> Page {
    let document = Html::parse_document(html);
    let text_of = |css: &str| {
        Selector::parse(css)
            .ok()
            .and_then(|selector| document.select(&selector).next())
            .map(|element| clean(&element.text().collect::<Vec<_>>().join(" ")))
            .unwrap_or_default()
    };
    let title = text_of("title");
    let description = attr(&document, "meta[name='description']", "content")
        .map(clean)
        .unwrap_or_default();
    let canonical_url =
        attr(&document, "link[rel='canonical']", "href").and_then(|value| url.join(value).ok());
    let mut headings = Vec::new();
    for level in 1..=6 {
        if let Ok(selector) = Selector::parse(&format!("h{level}")) {
            for element in document.select(&selector) {
                let text = clean(&element.text().collect::<Vec<_>>().join(" "));
                if !text.is_empty() {
                    headings.push(Heading { level, text });
                }
            }
        }
    }
    // Selecting "main,article,body" returned whichever matched first in
    // document order -- always <body> -- and kept script, style and navigation
    // text, so raw JS and menu chrome were sent on as the page's visible text.
    let text = ["main", "article", "body"]
        .iter()
        .find_map(|css| {
            Selector::parse(css)
                .ok()
                .and_then(|selector| document.select(&selector).next())
        })
        .map(readable_text)
        .unwrap_or_default()
        .chars()
        .take(MAX_TEXT_CHARS)
        .collect::<String>();
    let link_selector = Selector::parse("a[href]").unwrap();
    let links = document
        .select(&link_selector)
        .filter_map(|element| element.value().attr("href"))
        .filter_map(|value| url.join(value).ok())
        .filter(|value| matches!(value.scheme(), "http" | "https"))
        .collect();
    let json_selector = Selector::parse("script[type='application/ld+json']").unwrap();
    let json_ld = document
        .select(&json_selector)
        .filter_map(|element| serde_json::from_str(&element.inner_html()).ok())
        .collect();
    let open_graph = metadata(&document, "meta[property^='og:']", "property");
    let twitter = metadata(&document, "meta[name^='twitter:']", "name");
    let mut semantic_elements = Vec::new();
    let semantic_selector = Selector::parse("main,article,section,address,time,header").unwrap();
    for element in document.select(&semantic_selector).take(100) {
        let text = clean(&element.text().collect::<Vec<_>>().join(" "));
        if !text.is_empty() {
            semantic_elements.push(SemanticElement {
                tag: element.value().name().to_string(),
                text: text.chars().take(2000).collect(),
            });
        }
    }
    let fingerprint = hex::encode(Sha256::digest(text.as_bytes()));
    let id = page_id(&url);
    Page {
        id,
        url,
        status,
        title,
        description,
        canonical_url,
        headings,
        text,
        links,
        json_ld,
        open_graph,
        twitter,
        semantic_elements,
        fingerprint,
        content_type,
        duplicate_of: None,
    }
}

pub fn extract_markdown(url: Url, status: u16, content_type: String, markdown: &str) -> Page {
    let mut headings = Vec::new();
    let mut links = Vec::new();
    let mut paragraphs = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim();
        let hashes = trimmed
            .chars()
            .take_while(|character| *character == '#')
            .count();
        if (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ') {
            let text = clean(&trimmed[hashes + 1..]);
            if !text.is_empty() {
                headings.push(Heading {
                    level: hashes as u8,
                    text,
                });
            }
        } else if !trimmed.is_empty() && !trimmed.starts_with("```") {
            paragraphs.push(strip_markdown(trimmed));
        }
        let mut rest = trimmed;
        while let Some(start) = rest.find("](") {
            rest = &rest[start + 2..];
            let Some(end) = rest.find(')') else { break };
            let destination = rest[..end].split_whitespace().next().unwrap_or("");
            if let Ok(link) = url.join(destination) {
                if matches!(link.scheme(), "http" | "https") {
                    links.push(link);
                }
            }
            rest = &rest[end + 1..];
        }
    }
    let title = headings
        .first()
        .map(|heading| heading.text.clone())
        .unwrap_or_default();
    let description = paragraphs.first().cloned().unwrap_or_default();
    let text = clean(&format!(
        "{} {}",
        headings
            .iter()
            .map(|heading| heading.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        paragraphs.join(" ")
    ));
    let fingerprint = hex::encode(Sha256::digest(text.as_bytes()));
    let id = page_id(&url);
    Page {
        id,
        url,
        status,
        title,
        description,
        canonical_url: None,
        headings,
        text: text.clone(),
        links,
        json_ld: Vec::new(),
        open_graph: BTreeMap::new(),
        twitter: BTreeMap::new(),
        semantic_elements: vec![SemanticElement {
            tag: "markdown".into(),
            text: text.chars().take(2000).collect(),
        }],
        fingerprint,
        content_type,
        duplicate_of: None,
    }
}

fn strip_markdown(value: &str) -> String {
    clean(
        &value
            .replace(['*', '_', '`'], "")
            .replace("![", "[")
            .replace(['[', ']'], ""),
    )
}

fn attr<'a>(document: &'a Html, css: &str, name: &str) -> Option<&'a str> {
    Selector::parse(css)
        .ok()
        .and_then(|selector| document.select(&selector).next())
        .and_then(|element| element.value().attr(name))
}
fn metadata(document: &Html, css: &str, key_attribute: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    if let Ok(selector) = Selector::parse(css) {
        for element in document.select(&selector) {
            if let (Some(key), Some(value)) = (
                element.value().attr(key_attribute),
                element.value().attr("content"),
            ) {
                values.insert(key.to_string(), clean(value));
            }
        }
    }
    values
}
const MAX_TEXT_CHARS: usize = 100_000;
const CHROME_TAGS: [&str; 7] = [
    "script", "style", "noscript", "svg", "nav", "footer", "form",
];

/// Text of an element with page chrome skipped, in document order.
fn readable_text(root: ElementRef) -> String {
    let mut out = String::new();
    // Children are pushed reversed so popping walks them front to back.
    let mut stack: Vec<_> = root.children().rev().collect();
    while let Some(node) = stack.pop() {
        match node.value() {
            Node::Element(element) if CHROME_TAGS.contains(&element.name()) => continue,
            Node::Text(text) => {
                out.push_str(text);
                out.push(' ');
            }
            _ => {}
        }
        stack.extend(node.children().rev());
    }
    clean(&out)
}

/// Identity comes from the URL. A content hash collides across distinct pages
/// -- every empty page hashes alike -- and evidence IDs are built as
/// `${page.id}:${suffix}`, so colliding page IDs produced duplicate evidence
/// IDs downstream. The body hash stays available as `fingerprint`.
pub fn page_id(url: &Url) -> String {
    hex::encode(Sha256::digest(url.as_str().as_bytes()))
        .chars()
        .take(12)
        .collect()
}

fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_semantics_and_metadata() {
        let page=extract(Url::parse("https://example.com").unwrap(),200,"text/html".into(),"<title>Ada</title><meta name='description' content='AI engineer'><meta property='og:title' content='Ada'><main><h1>Ada Example</h1><p>Created Atlas.</p></main>");
        assert_eq!(page.title, "Ada");
        assert!(page.text.contains("Atlas"));
        assert_eq!(page.headings.len(), 1);
        assert_eq!(page.open_graph.get("og:title").unwrap(), "Ada");
    }
    #[test]
    fn drops_chrome_and_prefers_main_over_body() {
        let page = extract(
            Url::parse("https://example.com").unwrap(),
            200,
            "text/html".into(),
            "<body><nav>Home Pricing</nav><script>var secret = 1;</script>\
             <style>.a{color:red}</style><main><p>Body copy.</p></main>\
             <footer>Copyright</footer></body>",
        );
        assert!(page.text.contains("Body copy."));
        assert!(!page.text.contains("Pricing"));
        assert!(!page.text.contains("secret"));
        assert!(!page.text.contains("color:red"));
        assert!(!page.text.contains("Copyright"));
    }

    #[test]
    fn drops_chrome_when_falling_back_to_body() {
        let page = extract(
            Url::parse("https://example.com").unwrap(),
            200,
            "text/html".into(),
            "<body><nav>Menu</nav><script>alert(1)</script><p>Only copy.</p></body>",
        );
        assert!(page.text.contains("Only copy."));
        assert!(!page.text.contains("Menu"));
        assert!(!page.text.contains("alert"));
    }

    #[test]
    fn keeps_links_from_navigation() {
        let page = extract(
            Url::parse("https://example.com").unwrap(),
            200,
            "text/html".into(),
            "<body><nav><a href='/pricing'>Pricing</a></nav><main>x</main></body>",
        );
        assert!(page
            .links
            .iter()
            .any(|link| link.as_str() == "https://example.com/pricing"));
    }

    #[test]
    fn distinct_urls_get_distinct_ids_despite_identical_text() {
        let html = "<body><main>same</main></body>";
        let a = extract(
            Url::parse("https://example.com/a").unwrap(),
            200,
            "text/html".into(),
            html,
        );
        let b = extract(
            Url::parse("https://example.com/b").unwrap(),
            200,
            "text/html".into(),
            html,
        );
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn extracts_markdown_pages() {
        let page = extract_markdown(
            Url::parse("https://example.com/").unwrap(),
            200,
            "text/markdown".into(),
            "# Ada Lovelace\n\nAI engineer and creator.\n\n## Work\n[Atlas](/atlas)",
        );
        assert_eq!(page.title, "Ada Lovelace");
        assert!(page.text.contains("AI engineer"));
        assert_eq!(page.links[0].as_str(), "https://example.com/atlas");
    }
}
