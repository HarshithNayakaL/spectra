use scraper::{Html, Selector};
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
    let text = Selector::parse("main,article,body")
        .ok()
        .and_then(|selector| document.select(&selector).next())
        .map(|element| clean(&element.text().collect::<Vec<_>>().join(" ")))
        .unwrap_or_default();
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
    let id = fingerprint.chars().take(12).collect();
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
}
