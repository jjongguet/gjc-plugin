import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type AuditScope = "user" | "project";

export interface SkillRoot {
	scope: AuditScope;
	path: string;
	exists: boolean;
}

export interface InstalledSkill {
	/** Catalog id: the skill directory name. */
	name: string;
	path: string;
	root: string;
	scope: AuditScope;
	declaredName: string | null;
	description: string | null;
	contentHash: string;
}

export interface AuditCandidate {
	kind: "duplicate_name" | "identical_content" | "stale_replica";
	skills: string[];
	basis: string;
}

const STALE_REPLICA = /^(.+)\.stale-(\d{8})$/;

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** The two install scopes GJC loads skills from. Missing roots stay in the list, marked absent. */
export function skillRoots(home: string, cwd: string): SkillRoot[] {
	const roots: SkillRoot[] = [
		{ scope: "user", path: path.join(home, ".gjc", "agent", "skills"), exists: false },
		{ scope: "project", path: path.join(cwd, ".gjc", "skills"), exists: false },
	];
	for (const root of roots) root.exists = isDirectory(root.path);
	return roots;
}

/** Top-level `key: value` frontmatter fields. Unparseable headers yield no fields, never an exception. */
export function parseFrontmatter(text: string): Record<string, string> {
	const fields: Record<string, string> = {};
	if (!text.startsWith("---")) return fields;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return fields;
	for (const line of text.slice(3, end).split("\n")) {
		if (!line.includes(":") || /^[ \t]/.test(line)) continue;
		const at = line.indexOf(":");
		fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return fields;
}

/** Every installed skill (a directory holding SKILL.md), sorted by catalog name then scope. */
export function discoverSkills(roots: readonly SkillRoot[]): InstalledSkill[] {
	const skills: InstalledSkill[] = [];
	for (const root of roots) {
		if (!root.exists) continue;
		let entries;
		try {
			entries = readdirSync(root.path, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const dir = path.join(root.path, entry.name);
			let text: string;
			try {
				text = readFileSync(path.join(dir, "SKILL.md"), "utf8");
			} catch {
				continue;
			}
			const frontmatter = parseFrontmatter(text);
			skills.push({
				name: entry.name,
				path: dir,
				root: root.path,
				scope: root.scope,
				declaredName: frontmatter.name || null,
				description: frontmatter.description || null,
				contentHash: createHash("sha256").update(text).digest("hex"),
			});
		}
	}
	skills.sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0,
	);
	return skills;
}

/** Duplicate, identical-content and dated (.stale-YYYYMMDD) replica candidates with their basis. */
export function duplicateCandidates(skills: readonly InstalledSkill[]): AuditCandidate[] {
	const candidates: AuditCandidate[] = [];
	const byDeclaredName = new Map<string, InstalledSkill[]>();
	const byContent = new Map<string, InstalledSkill[]>();
	for (const skill of skills) {
		const declared = skill.declaredName || skill.name;
		const named = byDeclaredName.get(declared);
		if (named) named.push(skill);
		else byDeclaredName.set(declared, [skill]);
		const sameContent = byContent.get(skill.contentHash);
		if (sameContent) sameContent.push(skill);
		else byContent.set(skill.contentHash, [skill]);
	}
	for (const [declared, group] of byDeclaredName) {
		if (group.length < 2) continue;
		candidates.push({
			kind: "duplicate_name",
			skills: group.map(skill => skill.name),
			basis: `${group.length} installed copies declare frontmatter name '${declared}' (${group.map(skill => `${skill.scope}:${skill.name}`).join(", ")})`,
		});
	}
	for (const group of byContent.values()) {
		if (group.length < 2) continue;
		candidates.push({
			kind: "identical_content",
			skills: group.map(skill => skill.name),
			basis: `${group.length} installed copies share byte-identical SKILL.md content`,
		});
	}
	const catalog = new Set(skills.map(skill => skill.name));
	for (const skill of skills) {
		const match = STALE_REPLICA.exec(skill.name);
		if (!match || !catalog.has(match[1])) continue;
		candidates.push({
			kind: "stale_replica",
			skills: [match[1], skill.name],
			basis: `dated copy '${skill.name}' of installed '${match[1]}' is still exposed to the catalog`,
		});
	}
	candidates.sort((a, b) =>
		a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.skills[0] < b.skills[0] ? -1 : a.skills[0] > b.skills[0] ? 1 : 0,
	);
	return candidates;
}
