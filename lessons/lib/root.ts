// One wiki-root resolution for every lessons surface.
//
// `GJC_COMPOUND_ROOT` wins over `GJC_LESSONS_WIKI`, which wins over the owner's
// personal-wiki checkout under the home directory. Both names are accepted in
// one chain so `lessons_select` and `lessons_staged` can never disagree about
// which checkout they mean; an empty or blank value falls through, and `~`
// expands against the same home the daemon used.
import os from "node:os";
import path from "node:path";

export const COMPOUND_ROOT_ENV = "GJC_COMPOUND_ROOT";
export const LESSONS_WIKI_ENV = "GJC_LESSONS_WIKI";

export type RootDeps = { env?: Record<string, string | undefined>; home?: string };

function configuredRoot(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}

/** The wiki root: `GJC_COMPOUND_ROOT` → `GJC_LESSONS_WIKI` → `$HOME/jjongguet/personal-wiki`. */
export function compoundRoot(deps: RootDeps = {}): string {
	const env = deps.env ?? process.env;
	const home = deps.home ?? os.homedir();
	const configured = configuredRoot(env[COMPOUND_ROOT_ENV]) ?? configuredRoot(env[LESSONS_WIKI_ENV]);
	if (configured === null) return path.join(home, "jjongguet", "personal-wiki");
	return expandHome(configured, home);
}
