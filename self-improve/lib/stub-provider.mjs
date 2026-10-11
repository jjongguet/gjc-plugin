/**
 * Loopback scripted model provider for the stochastic runner's local_stub mode.
 * Binds 127.0.0.1 only and never proxies; serves the OpenAI Responses SSE shape
 * established by verification-receipts/scripts/smoke-host.mjs for gjc probes.
 */
import http from "node:http";

export async function startStubProvider({ scriptedTexts = ["value=1"] } = {}) {
  let callIndex = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o", object: "model", owned_by: "local" }] }));
        return;
      }
      if (req.url !== "/v1/responses") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unsupported_local_endpoint" } }));
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2_000_000) throw new Error("local_request_cap");
      }
      const text = scriptedTexts[Math.min(callIndex, scriptedTexts.length - 1)];
      callIndex += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const response = {
        id: `resp_local_${callIndex}`,
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      send({ type: "response.created", response: { ...response, status: "in_progress" } });
      const item = {
        id: `msg_local_${callIndex}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
      send({
        type: "response.output_text.delta",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: text,
      });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { ...response, output: [item] } });
      res.end();
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "local_stub_failed" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls: () => callIndex,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
