mod extract;
mod security;

use anyhow::{bail, Context, Result};
use extract::Page;
use reqwest::{header, redirect::Policy, Client};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    time::Duration,
};
use url::Url;

const MAX_PAGES: usize = 20;
const MAX_DEPTH: usize = 2;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Robots {
    url: Url,
    allowed: bool,
    sitemaps: Vec<Url>,
    status: Option<u16>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Edge {
    from: Url,
    to: Url,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    url: String,
    stage: String,
    error: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    max_pages: usize,
    max_depth: usize,
    max_bytes: usize,
    timeout_ms: u64,
    max_redirects: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    target: Url,
    started_at: String,
    completed_at: String,
    robots: Robots,
    pages: Vec<Page>,
    crawl_edges: Vec<Edge>,
    warnings: Vec<String>,
    failures: Vec<Failure>,
    limits: Limits,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        std::process::exit(1)
    }
}

async fn run() -> Result<()> {
    let raw = std::env::args()
        .nth(1)
        .context("usage: spectra-crawler <public-url>")?;
    let target = security::validate_public_url(&raw).await?;
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .user_agent("SPECTRA/0.1 (+https://github.com/HarshithNayakaL/spectra)")
        .build()?;
    let robots_url = target.join("/robots.txt")?;
    let robots = fetch_robots(&client, robots_url).await;
    if !robots.allowed {
        bail!("robots.txt disallows crawling this target")
    }
    let mut queue = VecDeque::from([(target.clone(), 0usize)]);
    let mut seen = HashSet::new();
    let mut pages = Vec::new();
    let mut edges = Vec::new();
    let mut fingerprints: HashMap<String, String> = HashMap::new();
    let mut warnings = Vec::new();
    let mut failures = Vec::new();
    while let Some((url, depth)) = queue.pop_front() {
        if pages.len() >= MAX_PAGES || !seen.insert(url.as_str().to_owned()) {
            continue;
        }
        match fetch_page(&client, url.clone()).await {
            Ok(mut page) => {
                if let Some(first) = fingerprints.get(&page.fingerprint) {
                    page.duplicate_of = Some(first.clone())
                } else {
                    fingerprints.insert(page.fingerprint.clone(), page.id.clone());
                }
                if depth < MAX_DEPTH {
                    for link in &page.links {
                        if link.domain() == target.domain() {
                            edges.push(Edge {
                                from: url.clone(),
                                to: link.clone(),
                            });
                            queue.push_back((link.clone(), depth + 1));
                        }
                    }
                }
                pages.push(page)
            }
            Err(error) => {
                let message = error.to_string();
                warnings.push(format!("{url}: {message}"));
                failures.push(Failure {
                    url: url.to_string(),
                    stage: "fetch".into(),
                    error: message,
                });
            }
        }
    }
    if pages.is_empty() {
        bail!("no crawlable HTML or Markdown pages were retrieved")
    }
    let now = timestamp();
    let output = Output {
        target,
        started_at: now.clone(),
        completed_at: now,
        robots,
        pages,
        crawl_edges: edges,
        warnings,
        failures,
        limits: Limits {
            max_pages: MAX_PAGES,
            max_depth: MAX_DEPTH,
            max_bytes: MAX_BYTES,
            timeout_ms: 10_000,
            max_redirects: MAX_REDIRECTS,
        },
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

async fn fetch_page(client: &Client, mut url: Url) -> Result<Page> {
    for _ in 0..=MAX_REDIRECTS {
        url = security::validate_public_url(url.as_str()).await?;
        let response = client.get(url.clone()).send().await?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(header::LOCATION)
                .context("redirect has no location")?
                .to_str()?;
            url = url.join(next)?;
            continue;
        }
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let normalized_content_type = content_type.to_ascii_lowercase();
        if !normalized_content_type.contains("text/html")
            && !normalized_content_type.contains("application/xhtml+xml")
            && !normalized_content_type.contains("text/markdown")
        {
            bail!("unsupported content type {content_type}")
        }
        if response.content_length().unwrap_or(0) as usize > MAX_BYTES {
            bail!("response exceeds size limit")
        }
        let bytes = response.bytes().await?;
        if bytes.len() > MAX_BYTES {
            bail!("response exceeds size limit")
        }
        let body = String::from_utf8_lossy(&bytes);
        return Ok(if normalized_content_type.contains("text/markdown") {
            extract::extract_markdown(url, status, content_type, &body)
        } else {
            extract::extract(url, status, content_type, &body)
        });
    }
    bail!("redirect limit exceeded")
}
async fn fetch_robots(client: &Client, url: Url) -> Robots {
    if security::validate_public_url(url.as_str()).await.is_err() {
        return Robots {
            url,
            allowed: false,
            sitemaps: vec![],
            status: None,
        };
    }
    match client.get(url.clone()).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let sitemaps = body
                .lines()
                .filter_map(|line| line.split_once(':'))
                .filter(|(name, _)| name.trim().eq_ignore_ascii_case("sitemap"))
                .filter_map(|(_, value)| Url::parse(value.trim()).ok())
                .collect();
            let denied =
                body.lines()
                    .filter_map(|line| line.split_once(':'))
                    .any(|(name, value)| {
                        name.trim().eq_ignore_ascii_case("disallow") && value.trim() == "/"
                    });
            Robots {
                url,
                allowed: !denied,
                sitemaps,
                status: Some(status),
            }
        }
        Err(_) => Robots {
            url,
            allowed: true,
            sitemaps: vec![],
            status: None,
        },
    }
}
fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}
