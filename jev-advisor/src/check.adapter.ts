// Explicit artifact-check surface. Provider calls are bounded and strict; the
// outcome journal is sanitized and the v2 correlation store is untouched.
// The relative import below is stripped by scripts/build.mjs, which inlines
// lib/decision.ts; the node:crypto import is aliased so the generated bundle
// keeps a single unaliased createHash binding from the inlined core.
import { createHash as checkDigestHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { appendPluginOutcome } from '../../shared/lib/results';
import { IMAGE_MAX_BYTES, MAX_CHECK_IMAGES, askCheckModel, inspectImage, noCheckDecision, prepareCheck, providerPromptLimit, readConfig, type CheckAdvice } from '../lib/decision';

type LoadedImages =
	| { status: 'ok'; images: { mediaType: 'image/png' | 'image/jpeg'; base64: string; width: number; height: number }[] }
	| { status: 'unsupported_input' | 'input_too_large' };

/**
 * Read check images from disk without letting the model or the journal see the
 * bytes. Count, byte size, format, dimensions and animated-PNG rejection are
 * deterministic and happen before any provider call; a rejected set is never
 * partially sent.
 */
function loadCheckImages(raw: unknown): LoadedImages {
	if (raw === undefined || raw === null) return { status: 'ok', images: [] };
	if (!Array.isArray(raw)) return { status: 'unsupported_input' };
	if (raw.length > MAX_CHECK_IMAGES) return { status: 'input_too_large' };
	const images: Extract<LoadedImages, { status: 'ok' }>['images'] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string' || !entry.trim()) return { status: 'unsupported_input' };
		const file = path.resolve(entry);
		try {
			const stats = statSync(file);
			if (!stats.isFile()) return { status: 'unsupported_input' };
			if (stats.size > IMAGE_MAX_BYTES) return { status: 'input_too_large' };
			const bytes = readFileSync(file);
			const inspected = inspectImage(bytes);
			if (inspected.status !== 'ok') return { status: inspected.status };
			images.push({ mediaType: inspected.image.mediaType, base64: bytes.toString('base64'), width: inspected.image.width, height: inspected.image.height });
		} catch {
			return { status: 'unsupported_input' };
		}
	}
	return { status: 'ok', images };
}

export default function jevCheck(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>) => unknown; String: (options?: Record<string, unknown>) => unknown; Array: (item: unknown, options?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
}) {
	return {
		name: 'jev_check',
		label: 'JEV Check',
		description: 'Ask the decision model to check one artifact against one check question; returns a strictly validated correct/incorrect/unsure verdict with confidence (probabilities when provided), or an explicit no-decision reason. Optional images (PNG/JPEG paths, at most 4; 256-1568 px per side) are inspected locally and sent as image parts to the OpenRouter jev route only, so an image-grounded verdict is possible; bytes are never journaled. Journals a sanitized check outcome under ~/.gjc-plugin; never touches correlation state, never blocks, and a verdict is an advisory opinion — not verification evidence, correctness proof or acceptance of quality.',
		parameters: pi.typebox.Type.Object({
			question: pi.typebox.Type.String({ description: 'One complete check question: what must be verified about the artifact' }),
			artifact: pi.typebox.Type.String({ description: 'The produced artifact or claim to check' }),
			images: pi.typebox.Type.Optional(pi.typebox.Type.Array(pi.typebox.Type.String({ description: 'PNG or JPEG file path (absolute, or relative to the session directory). At most 4 images; each 256-1568 px per side and at most 16 MiB.' }), { description: 'Images the verdict may be grounded on, in reading order. Rejected deterministically when a file is unreadable, animated, outside PNG/JPEG, or outside Jev image limits.' })),
		}),
		async execute(_toolCallId: string, params: { question?: unknown; artifact?: unknown; images?: unknown }) {
			const cfg = readConfig();
			const finish = async (value: CheckAdvice) => {
				const check = value.status === 'decision'
					? { status: value.status, verdict: value.verdict, confidence: value.confidence, confidenceKind: value.confidenceKind, ...(value.probabilities ? { probabilities: value.probabilities } : {}) }
					: { status: value.status, reason: value.reason };
				let journalStorage;
				try {
					journalStorage = await appendPluginOutcome('jev-advisor', {
						operation: 'check',
						toolCallDigest: checkDigestHash('sha256').update(_toolCallId).digest('hex'),
						stateOverrideIgnored: cfg.stateOverrideIgnored,
						check,
					});
				} catch { journalStorage = { persisted: false, reason: 'store_unavailable' }; }
				const persistence = { journalStorage, stateOverrideIgnored: cfg.stateOverrideIgnored };
				return { content: [{ type: 'text', text: JSON.stringify({ ...value, ...persistence }, null, 2) }] };
			};
			const loaded = loadCheckImages(params?.images);
			if (loaded.status !== 'ok') return finish(noCheckDecision(loaded.status));
			const prepared = prepareCheck(params?.question, params?.artifact, providerPromptLimit(cfg), loaded.images);
			if (prepared.status !== 'ok') return finish(noCheckDecision(prepared.status));
			try { return finish(await askCheckModel(cfg, prepared.check, (input, init) => fetch(input, init))); }
			catch { return finish(noCheckDecision('provider_error')); }
		},
	};
}
