import { handleApi } from "../../dist-server/server.js";

export default async function handler(nodeReq, nodeRes) {
  const rawPath = String(nodeReq.url ?? "/").replace(/^\/api\/app-api/, "/app-api");
  const chunks = [];
  for await (const chunk of nodeReq) chunks.push(Buffer.from(chunk));

  const req = new Request(new URL(rawPath, "https://sentry.invalid"), {
    method: nodeReq.method,
    headers: nodeReq.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    duplex: "half",
  });

  const res = await handleApi(req).catch((err) =>
    Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 }),
  );

  nodeRes.statusCode = res.status;
  res.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  nodeRes.end(Buffer.from(await res.arrayBuffer()));
}
