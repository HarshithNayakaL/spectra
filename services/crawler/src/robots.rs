//! RFC 9309 robots.txt group matching.
//!
//! The crawler previously treated *any* `Disallow: /` line as a site-wide
//! block, so a rule aimed at an unrelated bot locked SPECTRA out of sites it
//! was welcome to read. In the other direction, per-path rules were ignored
//! entirely and disallowed paths were crawled anyway.

use url::Url;

const TOKEN: &str = "spectra";

#[derive(Debug, Clone)]
pub struct Rule {
    pub allow: bool,
    pub path: String,
}

#[derive(Debug, Clone, Default)]
pub struct Rules {
    pub rules: Vec<Rule>,
    pub sitemaps: Vec<String>,
}

impl Rules {
    /// Used when robots.txt itself is not fetchable over a safe URL.
    pub fn blocked() -> Self {
        Self {
            rules: vec![Rule {
                allow: false,
                path: "/".into(),
            }],
            sitemaps: vec![],
        }
    }

    pub fn parse(text: &str) -> Self {
        let mut sitemaps = Vec::new();
        let mut groups: Vec<(Vec<String>, Vec<Rule>)> = Vec::new();
        let mut previous_was_agent = false;
        for raw in text.lines() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let Some((field, value)) = line.split_once(':') else {
                continue;
            };
            let field = field.trim().to_ascii_lowercase();
            let value = value.trim();
            match field.as_str() {
                "sitemap" => {
                    if !value.is_empty() {
                        sitemaps.push(value.to_string())
                    }
                }
                "user-agent" => {
                    if groups.is_empty() || !previous_was_agent {
                        groups.push((Vec::new(), Vec::new()));
                    }
                    if let Some(group) = groups.last_mut() {
                        group.0.push(value.to_ascii_lowercase());
                    }
                    previous_was_agent = true;
                }
                "allow" | "disallow" => {
                    previous_was_agent = false;
                    if let Some(group) = groups.last_mut() {
                        group.1.push(Rule {
                            allow: field == "allow",
                            path: value.to_string(),
                        });
                    }
                }
                _ => previous_was_agent = false,
            }
        }
        let named: Vec<&(Vec<String>, Vec<Rule>)> = groups
            .iter()
            .filter(|(agents, _)| agents.iter().any(|a| a == TOKEN))
            .collect();
        let wildcard: Vec<&(Vec<String>, Vec<Rule>)> = groups
            .iter()
            .filter(|(agents, _)| agents.iter().any(|a| a == "*"))
            .collect();
        let chosen = if named.is_empty() { wildcard } else { named };
        Self {
            rules: chosen
                .into_iter()
                .flat_map(|(_, rules)| rules.iter().cloned())
                .collect(),
            sitemaps,
        }
    }

    pub fn allows(&self, url: &Url) -> bool {
        let path = match url.query() {
            Some(query) => format!("{}?{}", url.path(), query),
            None => url.path().to_string(),
        };
        let mut decision: Option<(bool, usize)> = None;
        for rule in &self.rules {
            // An empty Disallow value grants permission and carries no path.
            if rule.path.is_empty() || !matches(&rule.path, &path) {
                continue;
            }
            let length = rule.path.len();
            // Longest match wins; Allow breaks ties, per RFC 9309.
            let better = match decision {
                None => true,
                Some((_, best)) if length > best => true,
                Some((_, best)) if length == best && rule.allow => true,
                _ => false,
            };
            if better {
                decision = Some((rule.allow, length));
            }
        }
        decision.map(|(allow, _)| allow).unwrap_or(true)
    }
}

fn matches(pattern: &str, path: &str) -> bool {
    let must_end = pattern.ends_with('$');
    let body = if must_end {
        &pattern[..pattern.len() - 1]
    } else {
        pattern
    };
    let segments: Vec<&str> = body.split('*').collect();
    let mut index = 0usize;
    for (position, segment) in segments.iter().enumerate() {
        if segment.is_empty() {
            continue;
        }
        if position == 0 {
            if !path.starts_with(segment) {
                return false;
            }
            index = segment.len();
            continue;
        }
        match path[index..].find(segment) {
            Some(found) => index += found + segment.len(),
            None => return false,
        }
    }
    if must_end {
        return if segments.len() == 1 {
            path == body
        } else {
            path.ends_with(segments[segments.len() - 1])
        };
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn url(path: &str) -> Url {
        Url::parse(&format!("https://example.com{path}")).unwrap()
    }

    #[test]
    fn ignores_a_block_aimed_at_another_agent() {
        let rules = Rules::parse("User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nAllow: /");
        assert!(rules.allows(&url("/")));
    }

    #[test]
    fn honours_a_wildcard_block() {
        let rules = Rules::parse("User-agent: *\nDisallow: /");
        assert!(!rules.allows(&url("/about")));
    }

    #[test]
    fn applies_per_path_rules() {
        let rules = Rules::parse("User-agent: *\nDisallow: /private");
        assert!(!rules.allows(&url("/private/x")));
        assert!(rules.allows(&url("/public")));
    }

    #[test]
    fn longest_match_wins_with_allow_breaking_ties() {
        let rules = Rules::parse("User-agent: *\nDisallow: /docs\nAllow: /docs/public");
        assert!(!rules.allows(&url("/docs/secret")));
        assert!(rules.allows(&url("/docs/public/a")));
    }

    #[test]
    fn prefers_the_group_naming_spectra() {
        let rules = Rules::parse("User-agent: *\nDisallow: /\n\nUser-agent: spectra\nAllow: /");
        assert!(rules.allows(&url("/")));
    }

    #[test]
    fn empty_disallow_is_permission() {
        let rules = Rules::parse("User-agent: *\nDisallow:");
        assert!(rules.allows(&url("/any")));
    }

    #[test]
    fn supports_wildcards_and_anchors() {
        let rules = Rules::parse("User-agent: *\nDisallow: /*.pdf$");
        assert!(!rules.allows(&url("/a/b.pdf")));
        assert!(rules.allows(&url("/a/b.html")));
    }

    #[test]
    fn missing_robots_allows_everything() {
        assert!(Rules::parse("").allows(&url("/")));
        assert!(Rules::default().allows(&url("/")));
    }

    #[test]
    fn collects_sitemaps() {
        let rules = Rules::parse("Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nAllow: /");
        assert_eq!(rules.sitemaps, vec!["https://example.com/sitemap.xml"]);
    }

    #[test]
    fn blocked_denies_everything() {
        assert!(!Rules::blocked().allows(&url("/")));
    }
}
