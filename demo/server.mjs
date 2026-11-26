import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const demoAttachments = new Map([
    ["/attachments/notes.txt", "Sample notes\nReview the first exercise.\n"],
    ["/attachments/checklist.txt", "Sample checklist\n[ ] Open both downloaded files.\n"],
    ["/attachments/readme.txt", "This ordinary link is outside the download list.\n"],
]);

const userscript = new URL("../web-attachment-helper.user.js", import.meta.url);
const demoPage = new URL("./index.html", import.meta.url);

export async function startDemo(port = 4173) {
    const page = await readFile(demoPage, "utf8");
    const script = await readFile(userscript, "utf8");
    const server = createServer((request, response) => {
        const url = new URL(request.url, "http://127.0.0.1");
        const send = (status, type, body) => {
            response.writeHead(status, {
                "Content-Type": type,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            });
            response.end(body);
        };

        if (request.method !== "GET") {
            send(405, "text/plain; charset=utf-8", "Method not allowed.\n");
        } else if (url.pathname === "/" || url.pathname === "/demo/") {
            const otherOrigin = `http://localhost:${server.address().port}`;
            send(200, "text/html; charset=utf-8", page.replace("{{otherOrigin}}", otherOrigin));
        } else if (url.pathname === "/web-attachment-helper.user.js") {
            send(200, "text/javascript; charset=utf-8", script);
        } else if (demoAttachments.has(url.pathname)) {
            send(200, "text/plain; charset=utf-8", demoAttachments.get(url.pathname));
        } else {
            send(404, "text/plain; charset=utf-8", "Attachment not found.\n");
        }
    });

    await new Promise((resolveListening, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolveListening();
        });
    });
    return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const server = await startDemo();
    const base = `http://127.0.0.1:${server.address().port}`;
    console.log(`Demo: ${base}/demo/`);
    console.log(`Userscript: ${base}/web-attachment-helper.user.js`);
}
