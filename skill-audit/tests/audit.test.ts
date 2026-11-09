import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { duplicateCandidates, discoverSkills, parseFrontmatter, skillRoots } from "../lib/catalog";
import { auditSkills, formatSummary } from "../lib/report";
import { scanUsage, skillArgumentName, slashSkillNames } from "../lib/usage";

const fixtures: string[] = [];

afterEach(() => {
	while (fixtures.length > 0) rmSync(fixtures.pop() as string, { recursive: true, force: true });
});

function fixtureHome(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "skill-audit-test-"));
	fixtures.push(dir);
	return dir;
}

function writeSkill(
	home: string,
	name: string,
	options: { declaredName?: string; body?: string; scope?: "user" | "project"; cwd?: string } = {},
): string {
	const root =
		options.scope === "project"
			? path.join(options.cwd ?? path.join(home, "work"), ".gjc", "skills")
			: path.join(home, ".gjc", "agent", "skills");
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	const frontmatter = `---\nname: ${options.declaredName ?? name}\ndescription: fixture skill for skill-audit tests\n---\n\n`;
	writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter}${options.body ?? `Body text for ${name}.`}\n`);
	return dir;
}

function writeTranscript(home: string, id: string, lines: string[], mtime?: string): string {
	const dir = path.join(home, ".gjc", "agent", "sessions", "v2-fixture");
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	if (mtime) utimesSync(file, new Date(mtime), new Date(mtime));
	return file;
}

const message = (role: string, timestamp: string, content: unknown[]) =>
	JSON.stringify({ type: "message", id: `m_${timestamp}_${role}`, timestamp, message: { role, content } });

const skillToolCall = (skill: string, timestamp: string, args?: unknown) =>
	message("assistant", timestamp, [{ type: "toolCall", id: `call_${skill}_${timestamp}`, name: "skill", arguments: args ?? { name: skill } }]);

const otherToolCall = (tool: string, timestamp: string, args: unknown) =>
	message("assistant", timestamp, [{ type: "toolCall", id: `call_${tool}_${timestamp}`, name: tool, arguments: args }]);

const userText = (text: string, timestamp: string) => message("user", timestamp, [{ type: "text", text }]);

describe("frontmatter and catalog discovery", () => {
	test("parses top-level frontmatter fields and tolerates a missing header", () => {
		expect(parseFrontmatter("---\nname: alpha\ndescription: first line: with colon\n---\nBody")).toEqual({
			name: "alpha",
			description: "first line: with colon",
		});
		expect(parseFrontmatter("no header here")).toEqual({});
		expect(parseFrontmatter("---\nname: open without terminator")).toEqual({});
	});

	test("discovers installed skills per scope and keeps missing roots explicit", () => {
		const home = fixtureHome();
		const cwd = path.join(home, "work");
		writeSkill(home, "alpha");
		writeSkill(home, "beta", { scope: "project", cwd });
		mkdirSync(path.join(home, ".gjc/agent/skills/not-a-skill"), { recursive: true });

		const roots = skillRoots(home, cwd);
		expect(roots.map(root => [root.scope, root.exists])).toEqual([
			["user", true],
			["project", true],
		]);
		const skills = discoverSkills(roots);
		expect(skills.map(skill => [skill.name, skill.scope, skill.declaredName])).toEqual([
			["alpha", "user", "alpha"],
			["beta", "project", "beta"],
		]);

		const missing = skillRoots(fixtureHome(), path.join(home, "absent"));
		expect(missing.map(root => root.exists)).toEqual([false, false]);
		expect(discoverSkills(missing)).toEqual([]);
	});
});

describe("transcript usage evidence", () => {
	test("missing or empty transcript coverage is unknown, never zero", () => {
		const home = fixtureHome();
		writeSkill(home, "alpha");
		const missing = auditSkills({ home, cwd: home });
		expect(missing.usage.status).toBe("unknown");
		expect(missing.status).toBe("unknown");
		expect(missing.counts).toMatchObject({ installed: 1, used: 0, unused: 0, usage_unknown: 1 });
		expect(missing.skills[0]).toMatchObject({
			name: "alpha",
			installed: true,
			source: "~/.gjc/agent/skills",
			used_count: null,
			last_used: null,
			verdict: "unknown",
		});
		expect(missing.candidates.unused).toEqual([]);
		expect(missing.usage.outside_roots).toEqual([]);
		expect(missing.counts.outside_roots).toBe(0);
		expect(formatSummary(missing)).toContain("withheld");

		mkdirSync(path.join(home, ".gjc/agent/sessions"), { recursive: true });
		const empty = scanUsage(path.join(home, ".gjc/agent/sessions"));
		expect(empty.status).toBe("unknown");
		expect(empty.rootExists).toBe(true);
		expect(empty.transcripts).toBe(0);
	});

	test("counts skill tool calls plus one prompt-only /skill: session, and ignores other tools", () => {
		const home = fixtureHome();
		writeSkill(home, "alpha");
		writeSkill(home, "beta");
		writeSkill(home, "gamma");
		writeTranscript(home, "s1", [
			skillToolCall("alpha", "2026-01-01T00:00:00.000Z"),
			skillToolCall("alpha", "2026-01-02T00:00:00.000Z", '{"name":"alpha"}'),
			otherToolCall("skill_discovery", "2026-01-02T01:00:00.000Z", { query: "gamma" }),
		]);
		writeTranscript(home, "s2", [userText("please run /skill:alpha now", "2026-01-03T00:00:00.000Z")]);
		writeTranscript(home, "s3", [
			userText("/skill:beta", "2026-01-04T00:00:00.000Z"),
			skillToolCall("beta", "2026-01-04T00:00:01.000Z"),
		]);
		writeTranscript(home, "s4", [skillToolCall("delta", "2026-01-05T00:00:00.000Z")]);

		const report = auditSkills({ home, cwd: home });
		expect(report.usage.status).toBe("ok");
		expect(report.status).toBe("complete");

		const alpha = report.skills.find(skill => skill.name === "alpha");
		expect(alpha).toMatchObject({
			used_count: 3,
			tool_calls: 2,
			prompt_invocations: 1,
			prompt_only_sessions: 1,
			sessions_used: 2,
			last_used: "2026-01-03T00:00:00.000Z",
			verdict: "used",
		});
		const beta = report.skills.find(skill => skill.name === "beta");
		expect(beta).toMatchObject({ used_count: 1, tool_calls: 1, prompt_invocations: 1, prompt_only_sessions: 0, sessions_used: 1 });
		const gamma = report.skills.find(skill => skill.name === "gamma");
		expect(gamma).toMatchObject({ used_count: 0, last_used: null, verdict: "unused" });
		expect(report.counts).toMatchObject({ installed: 3, used: 2, unused: 1, outside_roots: 1 });
		expect(report.usage.outside_roots).toEqual([{ name: "delta", used_count: 1, last_used: "2026-01-05T00:00:00.000Z" }]);
		expect(report.candidates.unused.map(candidate => candidate.name)).toEqual(["gamma"]);
		expect(report.candidates.unused[0].basis).toContain("4 retained transcripts");
	});

	test("a corrupt transcript line degrades the report without discarding valid usage", () => {
		const home = fixtureHome();
		writeSkill(home, "alpha");
		writeSkill(home, "beta");
		writeTranscript(home, "s1", [skillToolCall("alpha", "2026-01-01T00:00:00.000Z"), '{"type": "message", "skill": ']);

		const report = auditSkills({ home, cwd: home });
		expect(report.usage.status).toBe("degraded");
		expect(report.usage.corrupt_lines).toBe(1);
		expect(report.status).toBe("partial");
		expect(report.skills.find(skill => skill.name === "alpha")).toMatchObject({ used_count: 1, verdict: "used" });
		expect(report.candidates.unused.map(candidate => candidate.name)).toEqual(["beta"]);
		expect(report.candidates.unused[0].basis).toContain("1 corrupt line");
	});

	test("an unreadable transcript path degrades coverage instead of disappearing", () => {
		const home = fixtureHome();
		writeSkill(home, "alpha");
		writeTranscript(home, "s1", [skillToolCall("alpha", "2026-01-01T00:00:00.000Z")]);
		// A directory named like a transcript cannot be read as a file (EISDIR), on any uid.
		mkdirSync(path.join(home, ".gjc/agent/sessions/v2-fixture/broken.jsonl"), { recursive: true });

		const scan = scanUsage(path.join(home, ".gjc/agent/sessions"));
		expect(scan.transcripts).toBe(2);
		expect(scan.filesScanned).toBe(1);
		expect(scan.unreadableFiles).toBe(1);
		expect(scan.status).toBe("degraded");
		expect(scan.skills.get("alpha")?.toolCalls).toBe(1);
	});

	test("skill argument parsing accepts an object and a JSON string, rejects junk", () => {
		expect(skillArgumentName({ name: "alpha" })).toBe("alpha");
		expect(skillArgumentName('{"name":"beta"}')).toBe("beta");
		expect(skillArgumentName({ name: "  gamma  " })).toBe("gamma");
		expect(skillArgumentName({ name: "" })).toBeNull();
		expect(skillArgumentName({ name: 42 })).toBeNull();
		expect(skillArgumentName('{"name":')).toBeNull();
		expect(skillArgumentName(null)).toBeNull();
		expect(skillArgumentName(["alpha"])).toBeNull();
		expect(slashSkillNames("/skill:alpha and /skill:beta.tool but /skill:")).toEqual(["alpha", "beta.tool"]);
		expect(slashSkillNames("run /skill:gamma. then stop")).toEqual(["gamma"]);
		expect(slashSkillNames("/skill:up_skill-2 trailing")).toEqual(["up_skill-2"]);
	});
});

describe("duplicate and stale candidates", () => {
	test("flags duplicate declared names, identical content and dated stale replicas", () => {
		const home = fixtureHome();
		writeSkill(home, "alpha");
		writeSkill(home, "alpha-copy", { declaredName: "alpha" });
		writeSkill(home, "beta", { body: "shared identical body" });
		writeSkill(home, "beta-copy", { declaredName: "beta", body: "shared identical body" });
		writeSkill(home, "gamma");
		writeSkill(home, "gamma.stale-20260101", { declaredName: "gamma" });

		const skills = discoverSkills(skillRoots(home, home));
		const candidates = duplicateCandidates(skills);
		const kinds = candidates.map(candidate => `${candidate.kind}:${candidate.skills.join("+")}`);
		expect(kinds).toContain("duplicate_name:alpha+alpha-copy");
		expect(kinds).toContain("identical_content:beta+beta-copy");
		expect(kinds).toContain("stale_replica:gamma+gamma.stale-20260101");
		expect(candidates.find(candidate => candidate.kind === "stale_replica")?.basis).toContain("gamma.stale-20260101");

		const report = auditSkills({ home, cwd: home });
		expect(report.counts.duplicate_candidates).toBeGreaterThanOrEqual(3);
		expect(report.counts.stale_replicas).toBe(1);
	});

	test("a dated copy without its base is not reported as a stale replica", () => {
		const home = fixtureHome();
		writeSkill(home, "delta.stale-20260101");
		expect(duplicateCandidates(discoverSkills(skillRoots(home, home)))).toEqual([]);
	});
});

describe("report surface", () => {
	test("project-scope skills report their own install source", () => {
		const home = fixtureHome();
		const cwd = mkdtempSync(path.join(os.tmpdir(), "skill-audit-cwd-"));
		fixtures.push(cwd);
		writeSkill(home, "alpha", { scope: "project", cwd });
		writeTranscript(home, "s1", [skillToolCall("alpha", "2026-01-01T00:00:00.000Z")]);
		const report = auditSkills({ home, cwd, now: new Date("2026-02-01T00:00:00.000Z") });
		const row = report.skills.find(skill => skill.name === "alpha");
		expect(row).toMatchObject({ scope: "project", source: path.join(cwd, ".gjc/skills"), verdict: "used" });
		expect(report.generated_at).toBe("2026-02-01T00:00:00.000Z");
		expect(report.roots[1]).toEqual({ scope: "project", path: path.join(cwd, ".gjc/skills"), exists: true });
		expect(report.limitations.length).toBeGreaterThan(0);
	});

	test("human summary names each unused skill and states the shared basis once", () => {
		const home = fixtureHome();
		writeSkill(home, "alpha");
		writeSkill(home, "beta");
		writeTranscript(home, "s1", [skillToolCall("alpha", "2026-01-01T00:00:00.000Z")]);
		const summary = formatSummary(auditSkills({ home, cwd: home }));
		expect(summary).toContain("2 installed · 1 used · 1 unused");
		expect(summary).toContain("unused (1)");
		expect(summary).toContain("○ beta");
		expect(summary).not.toContain("○ alpha");
	});
});
