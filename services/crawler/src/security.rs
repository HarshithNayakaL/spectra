use anyhow::{bail, Context, Result};
use std::net::{IpAddr, Ipv4Addr};
use tokio::net::lookup_host;
use url::Url;

pub async fn validate_public_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).context("invalid URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("only HTTP and HTTPS URLs are allowed")
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("embedded credentials are not allowed")
    }
    let host = url.host_str().context("URL has no host")?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        bail!("local targets are blocked")
    }
    let port = url
        .port_or_known_default()
        .context("URL has no usable port")?;
    let addrs = lookup_host((host, port))
        .await
        .context("DNS resolution failed")?
        .map(|x| x.ip())
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        bail!("target resolved to no addresses")
    }
    if addrs.iter().any(|ip| !is_public(*ip)) {
        bail!("target resolves to a non-public address")
    }
    Ok(url)
}

pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => is_public_v4(v),
        IpAddr::V6(v) => {
            // An IPv4-mapped address must face the IPv4 rules. std's
            // is_loopback() is false for ::ffff:127.0.0.1, so checking only the
            // IPv6 predicates let the whole private IPv4 space through in
            // mapped form -- including the cloud metadata endpoint.
            if let Some(mapped) = v.to_ipv4_mapped() {
                return is_public_v4(mapped);
            }
            // to_ipv4() also covers the deprecated IPv4-compatible form.
            if let Some(compat) = v.to_ipv4() {
                return is_public_v4(compat);
            }
            let segments = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_unique_local()
                || v.is_unicast_link_local()
                || v.is_multicast()
                // 6to4 and NAT64 can both carry a private IPv4 destination.
                || segments[0] == 0x2002
                || (segments[0] == 0x0064 && segments[1] == 0xff9b))
        }
    }
}

fn is_public_v4(v: Ipv4Addr) -> bool {
    let [a, b, ..] = v.octets();
    !(v.is_private()
        || v.is_loopback()
        || v.is_link_local()
        || v.is_unspecified()
        || v.is_broadcast()
        || v.is_documentation()
        || a == 0
        || a >= 224
        // 100.64.0.0/10 carrier-grade NAT, 192.0.0.0/24 IETF protocol
        // assignments, 198.18.0.0/15 benchmarking: all reachable internal
        // space that none of the std predicates cover.
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0)
        || (a == 198 && (18..=19).contains(&b)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn v6(value: &str) -> IpAddr {
        value.parse::<Ipv6Addr>().unwrap().into()
    }

    #[test]
    fn blocks_private_and_metadata() {
        for ip in [
            Ipv4Addr::new(127, 0, 0, 1),
            Ipv4Addr::new(10, 0, 0, 2),
            Ipv4Addr::new(169, 254, 169, 254),
            Ipv4Addr::new(172, 16, 0, 1),
            Ipv4Addr::new(172, 31, 255, 255),
            Ipv4Addr::new(192, 168, 1, 1),
            Ipv4Addr::new(100, 64, 0, 1),
            Ipv4Addr::new(192, 0, 0, 1),
            Ipv4Addr::new(198, 18, 0, 1),
            Ipv4Addr::new(0, 0, 0, 0),
            Ipv4Addr::new(224, 0, 0, 1),
        ] {
            assert!(!is_public(ip.into()), "{ip} should be blocked")
        }
    }

    #[test]
    fn blocks_ipv4_mapped_private_addresses() {
        for value in [
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:10.0.0.1",
            "::ffff:172.16.0.1",
            "::ffff:192.168.1.1",
            "::ffff:100.64.0.1",
        ] {
            assert!(!is_public(v6(value)), "{value} should be blocked")
        }
    }

    #[test]
    fn blocks_ipv6_internal_and_tunnelled() {
        for value in ["::1", "::", "fc00::1", "fd00::1", "fe80::1", "ff02::1"] {
            assert!(!is_public(v6(value)), "{value} should be blocked")
        }
        assert!(!is_public(v6("2002:7f00:1::1")), "6to4 should be blocked");
        assert!(!is_public(v6("64:ff9b::7f00:1")), "NAT64 should be blocked");
    }

    #[test]
    fn permits_public() {
        assert!(is_public(Ipv4Addr::new(93, 184, 216, 34).into()));
        assert!(is_public(Ipv4Addr::new(8, 8, 8, 8).into()));
        assert!(is_public(v6("2606:2800:220:1:248:1893:25c8:1946")));
        assert!(is_public(v6("2606:4700:4700::1111")));
        assert!(is_public(v6("::ffff:93.184.216.34")));
    }
}
