import { createServer } from "node:http";
import { handleApi } from "./server";

const port = Number(process.env.PORT ?? 8787);

createServer(async (nodeReq, nodeRes) => {
  const path = nodeReq.url ?? "/";
  const chunks: Buffer[] = [];
  for await (const chunk of nodeReq) chunks.push(Buffer.from(chunk));

  const req = new Request(new URL(path, "http://127.0.0.1").toString(), {
    method: nodeReq.method,
    headers: nodeReq.headers as HeadersInit,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const res = await handleApi(req).catch((err) =>
    Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 }),
  );

  nodeRes.statusCode = res.status;
  res.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  nodeRes.end(Buffer.from(await res.arrayBuffer()));
}).listen(port, "127.0.0.1", () => {
  console.log(`SENTRY API listening on http://127.0.0.1:${port}`);
});
