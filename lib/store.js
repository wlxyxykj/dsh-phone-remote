/**
 * Tiny JSON state file for durable plugin state (the access token).
 *
 * Lives next to the rest of the user's DSH state (`$DSH_HOME`), written
 * atomically and owner-only on POSIX, so the same phone link keeps working
 * across DSH restarts.
 */

import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** File name inside the DSH home directory. */
const FILENAME = "dsh-phone-remote.json";
/** Name used before the package was renamed; read once so tokens survive. */
const LEGACY_FILENAME = "mobile-remote.json";

/** Absolute path of the state file. */
export function statePath() {
	return join(homeDirectory(), FILENAME);
}

/** Absolute path of the pre-rename state file. */
export function legacyStatePath() {
	return join(homeDirectory(), LEGACY_FILENAME);
}

/** `$DSH_HOME`, or `~/.dsh` when it is unset. */
function homeDirectory() {
	return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
		? process.env.DSH_HOME
		: join(homedir(), ".dsh");
}

/** Read the state object; `{}` when absent or unreadable. */
export function readState() {
	// Fall back to the pre-rename file so an existing token/allowlist carries
	// over; every write goes to the new path.
	for (const file of [statePath(), legacyStatePath()]) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			/* try the next candidate */
		}
	}
	return {};
}

/** Persist the state object atomically (tmp + rename, direct write fallback). */
export function writeState(state) {
	const file = statePath();
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, file);
	} catch {
		// A transient Windows lock can defeat rename; a direct write is fine for
		// this single-process, single-writer case.
		writeFileSync(file, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
	}
	return state;
}
