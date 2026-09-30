/**
 * Network helpers: find the LAN addresses a phone could actually reach.
 *
 * The DSH web GUI binds to loopback only, so it is invisible to a phone. This
 * plugin runs its own listener on `host` (0.0.0.0 by default) and this module
 * works out which of the machine's IPv4 addresses are worth printing as the
 * link a phone should open.
 */

import { networkInterfaces } from "node:os";

/** Interface names that are almost always virtual / unreachable from a phone. */
const VIRTUAL_NAMES = /(loopback|virtualbox|vmware|hyper-?v|docker|veth|bridge|tun\b|tap\b|utun|wsl|npcap|bluetooth|radmin|hamachi|pseudo)/i;
/** Overlay-network interfaces (Tailscale/ZeroTier): reachable from the far end, so rank them high. */
const OVERLAY_NAMES = /(tailscale|zerotier|headscale|netbird)/i;
/** Interface names that usually mean the real Wi-Fi / wired LAN. */
const WIFI_NAMES = /(wi-?fi|wlan|wireless|无线)/i;
const WIRED_NAMES = /(ethernet|以太网|本地连接)/i;

/** Whether an IPv4 literal is in RFC 1918, CGNAT or the Tailscale 100.64.0.0/10 range. */
export function isPrivateIpv4(address) {
	const parts = address.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b] = parts;
	return a === 10
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| (a === 100 && b >= 64 && b <= 127);
}

/**
 * Every non-loopback IPv4 address of this machine, best candidate first.
 * @returns {{ name: string, address: string, isPrivate: boolean, isVirtual: boolean, isOverlay: boolean, score: number }[]}
 */
export function listLanAddresses() {
	const found = [];
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const info of addresses ?? []) {
			// Node reports family as 'IPv4' (string) on current versions.
			if (info.family !== "IPv4" || info.internal) continue;
			if (info.address.startsWith("169.254.")) continue; // APIPA: never routable
			const isOverlay = OVERLAY_NAMES.test(name);
			const isVirtual = !isOverlay && VIRTUAL_NAMES.test(name);
			const isPrivate = isPrivateIpv4(info.address);
			// A Tailscale/ZeroTier address works from anywhere and is encrypted, so
			// it outranks Wi-Fi; virtual adapters go last by a wide margin.
			const score = (isOverlay ? 120 : 0)
				+ (WIFI_NAMES.test(name) ? 100 : WIRED_NAMES.test(name) ? 60 : 40)
				+ (isPrivate ? 20 : 0)
				- (isVirtual ? 200 : 0);
			found.push({ name, address: info.address, isPrivate, isVirtual, isOverlay, score });
		}
	}
	return found.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
}

/** Build an `http://host:port/path` URL, bracketing IPv6 literals. */
export function httpUrl(host, port, path = "/") {
	const authority = host.includes(":") ? `[${host}]` : host;
	return `http://${authority}:${port}${path}`;
}
