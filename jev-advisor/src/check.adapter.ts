// Explicit artifact-check surface. Provider calls are bounded and strict; the
// outcome journal is sanitized and the v2 correlation store is untouched.
// The relative import below is stripped by scripts/build.mjs, which inlines
// lib/decision.ts; the node:crypto import is aliased so the generated bundle
// keeps a single unaliased createHash binding from the inlined core.
import { createHash as checkDigestHash } from "node:crypto";
import { appendPluginOutcome } from '../../shared/lib/results';
import { askCheckModel, noCheckDecision, prepareCheck, providerPromptLimit, readConfig, type CheckAdvice } from '../lib/decision';

export default function jevCheck(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>) => unknown; String: (options?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
}) {
	return {
		name: 'jev_check',
		label: 'JEV Check',
		description: 'Ask the decision model to check one artifact against one check question; returns a strictly validated correct/incorrect/unsure verdict with confidence (probabilities when provided), or an explicit no-decision reason. Journals a sanitized check outcome under ~/.gjc-plugin; never touches correlation state, never blocks, and a verdict is an advisory opinion — not verification evidence, correctness proof or acceptance of quality.',
		parameters: pi.typebox.Type.Object({
			question: pi.typebox.Type.String({ description: 'One complete check question: what must be verified about the artifact' }),
			artifact: pi.typebox.Type.String({ description: 'The produced artifact or claim to check' }),
		}),
		async execute(_toolCallId: string, params: { question?: unknown; artifact?: unknown }) {
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
			const prepared = prepareCheck(params?.question, params?.artifact, providerPromptLimit(cfg));
			if (prepared.status !== 'ok') return finish(noCheckDecision(prepared.status));
			try { return finish(await askCheckModel(cfg, prepared.check, (input, init) => fetch(input, init))); }
			catch { return finish(noCheckDecision('provider_error')); }
		},
	};
}
