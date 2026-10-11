// Thin adapter for the plugin_metrics tool: accepts exactly {} and delegates
// to the canonical decision.ts report orchestration. No journaling, no
// provider, no config/credential reads — the report is strictly read-only.
import { buildPluginMetricsReport } from '../lib/decision';

export default function pluginMetrics(pi: {
	typebox: { Type: { Object: (fields: Record<string, unknown>) => unknown; String: (options?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
}) {
	return {
		name: 'plugin_metrics',
		label: 'Plugin Metrics',
		description: 'One bounded offline aggregate report of the three plugins\' retained sanitized journals and Jev\'s retained v2 correlation state. Read-only: creates nothing, appends nothing, no provider/browser/tests. Missing is not zero; unmeasured is null. Descriptive monitoring only — never proof of routing accuracy, task quality or causal benefit.',
		parameters: pi.typebox.Type.Object({}),
		async execute(_toolCallId: string, params: unknown) {
			// Reject anything other than an ordinary empty object before store reads.
			let exactEmptyObject = false;
			if (typeof params === 'object' && params !== null) {
				try {
					exactEmptyObject = !Array.isArray(params) && Object.getPrototypeOf(params) === Object.prototype && Reflect.ownKeys(params).length === 0;
				} catch {
					// An input that cannot be inspected is not the exact {} contract.
				}
			}
			if (!exactEmptyObject) {
				return { content: [{ type: 'text', text: 'plugin_metrics: invalid_input. This tool accepts exactly {} — no user paths, filters or config.' }], isError: true };
			}
			try {
				const report = await buildPluginMetricsReport();
				return { content: [{ type: 'text', text: JSON.stringify(report) }] };
			} catch {
				return { content: [{ type: 'text', text: 'plugin_metrics: unexpected_error. The report could not be produced.' }], isError: true };
			}
		},
	};
}
