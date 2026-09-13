use anyhow::{bail, Context, Result};
use std::net::IpAddr;
use tokio::net::lookup_host;
use url::Url;

pub async fn validate_public_url(raw: &str) -> Result<Url> {
    let url=Url::parse(raw).context("invalid URL")?;
    if !matches!(url.scheme(),"http"|"https") { bail!("only HTTP and HTTPS URLs are allowed") }
    if !url.username().is_empty() || url.password().is_some() { bail!("embedded credentials are not allowed") }
    let host=url.host_str().context("URL has no host")?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") { bail!("local targets are blocked") }
    let port=url.port_or_known_default().context("URL has no usable port")?;
    let addrs=lookup_host((host,port)).await.context("DNS resolution failed")?.map(|x|x.ip()).collect::<Vec<_>>();
    if addrs.is_empty() { bail!("target resolved to no addresses") }
    if addrs.iter().any(|ip| !is_public(*ip)) { bail!("target resolves to a non-public address") }
    Ok(url)
}

pub fn is_public(ip:IpAddr)->bool { match ip { IpAddr::V4(v)=>!(v.is_private()||v.is_loopback()||v.is_link_local()||v.is_unspecified()||v.is_broadcast()||v.is_documentation()||v.octets()[0]==0||v.octets()[0]>=224||v.octets()==[169,254,169,254]), IpAddr::V6(v)=>!(v.is_loopback()||v.is_unspecified()||v.is_unique_local()||v.is_unicast_link_local()||v.is_multicast()) } }

#[cfg(test)] mod tests{use super::*;use std::net::{Ipv4Addr,Ipv6Addr};#[test]fn blocks_private_and_metadata(){for ip in [Ipv4Addr::new(127,0,0,1),Ipv4Addr::new(10,0,0,2),Ipv4Addr::new(169,254,169,254)]{assert!(!is_public(ip.into()))}}#[test]fn permits_public(){assert!(is_public(Ipv4Addr::new(93,184,216,34).into()));assert!(is_public("2606:2800:220:1:248:1893:25c8:1946".parse::<Ipv6Addr>().unwrap().into()))}}
