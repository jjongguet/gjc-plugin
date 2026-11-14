// jev-checkpoint session_shutdown hook: releases the ended session's trigger
// state so nothing carries into a later session in the same process.
import { sessionIdOf, sessionStore } from "./core";

export default function register(api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) {
	api.on("session_shutdown", async (_event: unknown, ctx: any) => {
		try { sessionStore().delete(sessionIdOf(ctx)); } catch { /* nothing to release */ }
		return undefined;
	});
}
