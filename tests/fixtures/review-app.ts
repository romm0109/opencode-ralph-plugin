import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeReviewApp(directory: string) {
  await writeFile(
    join(directory, "app.json"),
    JSON.stringify({ operation: "add" }),
  );
  await writeFile(
    join(directory, "form.html"),
    `<!doctype html><html><body><form><label>A<input name="a" type="number"></label><label>B<input name="b" type="number"></label><button>Sum</button></form><output></output><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const data=new FormData(e.target);const r=await fetch('/api/sum',{method:'POST',body:JSON.stringify({a:Number(data.get('a')),b:Number(data.get('b'))})});document.querySelector('output').textContent=(await r.json()).sum}</script></body></html>`,
  );
}
/** Only committed fixture content in the provided review workspace determines behavior. */
export async function startReviewApp(workspace: string) {
  const html = await readFile(join(workspace, "form.html"), "utf8");
  const config = JSON.parse(
    await readFile(join(workspace, "app.json"), "utf8"),
  );
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        new URL(request.url).pathname === "/api/sum" &&
        request.method === "POST"
      ) {
        const { a, b } = await request.json();
        return Response.json({
          sum: config.operation === "add" ? a + b : a - b,
        });
      }
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
}
