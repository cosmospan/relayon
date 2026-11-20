import { BlockList, isIP } from "node:net";

/** Internal ranges blocked after DNS resolution, spec §11.9. */
const V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
];
const V6 = ["::1/128", "::/128", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b::/96", "64:ff9b:1::/48", "2001:db8::/32", "100::/64"];

const blocklist = new BlockList();
for (const c of V4) {
  const [net, len] = c.split("/") as [string, string];
  blocklist.addSubnet(net, Number(len), "ipv4");
}
for (const c of V6) {
  const [net, len] = c.split("/") as [string, string];
  blocklist.addSubnet(net, Number(len), "ipv6");
}

/** Returns the embedded IPv4 address of an IPv4-mapped / -compatible IPv6 address, if any. */
export function embeddedV4(ip: string): string | undefined {
  const m = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(ip) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (!m) return undefined;
  const rest = m[1]!;
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return undefined;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedIp(ip: string): boolean {
  const unbracketed = ip.replace(/^\[|\]$/g, "");
  const fam = isIP(unbracketed);
  if (fam === 4) return blocklist.check(unbracketed, "ipv4");
  if (fam === 6) {
    const v4 = embeddedV4(unbracketed);
    if (v4) return blocklist.check(v4, "ipv4");
    return blocklist.check(unbracketed, "ipv6");
  }
  return true; // not an IP: treat as blocked
}
