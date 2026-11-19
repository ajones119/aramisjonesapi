import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const COOKIE_NAME = "place_visitor";
const cookiePattern = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=(([0-9a-f]{32})\\.([0-9a-f]{64}))(?=;|$)`);

function signature(id: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(id).digest();
}

function verifiedToken(header: string | null | undefined, secret: string): string | undefined {
  if (!header) return;
  const match = cookiePattern.exec(header);
  if (!match) return;
  const [, token, id, mac] = match;
  if (timingSafeEqual(signature(id, secret), Buffer.from(mac, "hex"))) return token;
}

export function refreshVisitorCookie(header: string | undefined, secret: string): string {
  let token = verifiedToken(header, secret);
  if (!token) {
    const id = randomBytes(16).toString("hex");
    token = `${id}.${signature(id, secret).toString("hex")}`;
  }
  return `${COOKIE_NAME}=${token}`;
}

export function authenticateVisitor(header: string | null, secret: string): string | undefined {
  const token = verifiedToken(header, secret);
  if (!token) return;
  // Keep only a keyed identity in the room, never the reusable cookie or its random ID.
  return createHmac("sha256", secret).update(`visitor:${token}`).digest("hex");
}

function ipv4Groups(address: string): [number, number] {
  const octets = address.split(".").map(Number);
  return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
}

function ipv6Groups(address: string): number[] {
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const parse = (section: string): number[] => {
    if (!section) return [];
    const parts = section.split(":");
    const last = parts.at(-1)!;
    if (last.includes(".")) {
      parts.pop();
      return [...parts.map(part => Number.parseInt(part, 16)), ...ipv4Groups(last)];
    }
    return parts.map(part => Number.parseInt(part, 16));
  };
  const left = parse(head);
  const right = parse(tail);
  return address.includes("::")
    ? [...left, ...new Array(8 - left.length - right.length).fill(0), ...right]
    : left;
}

function networkIdentity(ip: string): string {
  const address = ip.split("%", 1)[0];
  if (isIP(address) !== 6) return address;

  const groups = ipv6Groups(address);
  const mappedIpv4 = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  if (mappedIpv4) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(":")}/64`;
}

export function hashNetwork(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(`network:${networkIdentity(ip)}`).digest("hex");
}
