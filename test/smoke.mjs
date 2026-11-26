import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { demoAttachments, startDemo } from "../demo/server.mjs";

async function browserExecutable() {
    if (process.env.CHROME_PATH) {
        await access(process.env.CHROME_PATH);
        return process.env.CHROME_PATH;
    }

    const windowsRoots = [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        process.env.LOCALAPPDATA,
    ].filter(Boolean);
    const candidates = [
        ...windowsRoots.flatMap((root) => [
            join(root, "Google", "Chrome", "Application", "chrome.exe"),
            join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((directory) =>
            ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome.exe", "msedge", "msedge.exe"]
                .map((name) => join(directory, name))),
    ];
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch (error) {
            if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) {
                throw error;
            }
        }
    }
    throw new Error("Set CHROME_PATH to a Chrome, Edge, or Chromium executable.");
}

async function waitFor(description, check) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        const result = await check();
        if (result) return result;
        await delay(75);
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

async function devTools(scratch, browser) {
    const address = await waitFor("the Chromium debugging endpoint", async () => {
        if (browser.exitCode !== null) {
            throw new Error(`Chromium exited with code ${browser.exitCode} before debugging started.`);
        }
        try {
            const [port, path] = (await readFile(join(scratch, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
            return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    });
    const socket = new WebSocket(address);
    const timeout = AbortSignal.timeout(5_000);
    await Promise.race([
        once(socket, "open", { signal: timeout }),
        once(socket, "error", { signal: timeout }).then(() => {
            throw new Error("Could not connect to Chromium DevTools.");
        }),
    ]);
    return socket;
}

function devToolsCommands(socket) {
    let nextId = 0;
    return (method, params = {}, sessionId) => {
        assert.equal(socket.readyState, WebSocket.OPEN, "The Chromium debugging socket is closed.");
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timeout = setTimeout(() => {
                socket.removeEventListener("message", receive);
                reject(new Error(`Timed out running Chromium command ${method}.`));
            }, 5_000);
            const receive = (event) => {
                const reply = JSON.parse(event.data);
                if (reply.id !== id) return;
                clearTimeout(timeout);
                socket.removeEventListener("message", receive);
                if (reply.error) {
                    reject(new Error(`${method}: ${reply.error.message}`));
                } else {
                    resolve(reply.result);
                }
            };
            socket.addEventListener("message", receive);
            socket.send(JSON.stringify({ id, method, params, sessionId }));
        });
    };
}

const binary = await browserExecutable();
const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryRoot, "web-attachment-helper-test-"));
assert.equal(dirname(temporary), temporaryRoot);
const profile = join(temporary, "profile");
const downloads = join(temporary, "downloads");
let server;
let browser;
let browserExited;
let socket;
let command;

try {
    await mkdir(downloads);
    server = await startDemo(0);
    assert.equal(server.address().address, "127.0.0.1");
    const requests = [];
    server.on("request", (request) => {
        if (request.url.startsWith("/attachments/")) requests.push(request.url);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const installer = await fetch(`${origin}/web-attachment-helper.user.js`);
    assert.equal(installer.status, 200);
    assert.match(installer.headers.get("content-type"), /^text\/javascript\b/);
    const script = await installer.text();
    assert.match(script, /^\/\/ ==UserScript==\r?\n/);

    browser = spawn(binary, [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-proxy-server",
        "--disable-background-networking",
        "--disable-extensions",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    browserExited = once(browser, "exit");
    await once(browser, "spawn");
    socket = await devTools(profile, browser);
    command = devToolsCommands(socket);
    await command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    const { targetId } = await command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
    await command("Page.enable", {}, sessionId);

    const evaluate = async (expression) => {
        const { result, exceptionDetails } = await command("Runtime.evaluate", {
            expression,
            returnByValue: true,
        }, sessionId);
        if (exceptionDetails) {
            throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        }
        return result.value;
    };
    const rowSelector = 'document.querySelector("#web-attachment-helper").shadowRoot';
    const rows = () => evaluate(`Array.from(${rowSelector}.querySelectorAll(".attachment"), (row) => ({
        name: row.querySelector(".attachment-name").textContent.trim(),
        status: row.dataset.status,
    }))`);

    await command("Page.addScriptToEvaluateOnNewDocument", {
        // The browser runs the served production source. Only the extension menu API is substituted.
        source: `globalThis.GM_registerMenuCommand = (label, callback) => {
            globalThis.demoMenu = { label, callback };
        };\n${script}`,
    }, sessionId);
    const navigation = await command("Page.navigate", { url: `${origin}/demo/` }, sessionId);
    assert.equal(navigation.errorText, undefined, "Chromium could not load the local demo.");
    const menu = await waitFor("the userscript menu", () =>
        evaluate('document.readyState === "complete" && globalThis.demoMenu?.label')
    ).catch(async (error) => {
        const page = await evaluate('({ url: location.href, title: document.title, hook: typeof GM_registerMenuCommand })');
        throw new Error(`${error.message} Chromium page: ${JSON.stringify(page)}`, { cause: error });
    });
    assert.equal(menu, "网页附件助手");
    await evaluate("globalThis.demoMenu.callback()");
    await waitFor("the attachment panel", () => evaluate('Boolean(document.querySelector("#web-attachment-helper")?.shadowRoot)'));
    assert.deepEqual(await rows(), [
        { name: "missing.txt", status: "pending" },
        { name: "notes.txt", status: "pending" },
        { name: "checklist.txt", status: "pending" },
    ], "Only explicitly marked same-origin links belong in the list, with duplicates removed.");
    assert.deepEqual(requests, [], "Scanning attachments should not fetch them.");

    await evaluate(`${rowSelector}.querySelector('[data-action="download-all"]').click()`);
    const finished = await waitFor("the batch to finish", async () => {
        const state = await rows();
        return state.every((row) => ["submitted", "failed"].includes(row.status)) ? state : undefined;
    });
    assert.deepEqual(finished, [
        { name: "missing.txt", status: "failed" },
        { name: "notes.txt", status: "submitted" },
        { name: "checklist.txt", status: "submitted" },
    ]);
    assert.match(await evaluate(`${rowSelector}.querySelector('[data-status="failed"] .attachment-status').textContent`), /404/);
    assert.deepEqual(requests, [
        "/attachments/missing.txt",
        "/attachments/notes.txt",
        "/attachments/checklist.txt",
    ], "The queue should continue with later attachments after a failure.");

    const saved = await waitFor("both written files", async () => {
        const files = (await readdir(downloads)).sort();
        return files.includes("checklist.txt") && files.includes("notes.txt") ? files : undefined;
    });
    assert.deepEqual(saved, ["checklist.txt", "notes.txt"]);
    for (const name of saved) {
        const bytes = await readFile(join(downloads, name));
        assert.deepEqual(bytes, Buffer.from(demoAttachments.get(`/attachments/${name}`), "utf8"));
    }

    await evaluate(`${rowSelector}.querySelector('[data-status="failed"] [data-action="download-one"]').click()`);
    await waitFor("the failed row to finish retrying", async () =>
        requests.length === 4 && (await rows())[0].status === "failed");
    assert.equal(requests[3], "/attachments/missing.txt");
    console.log("Chromium smoke passed: link selection, deduplication, queue after HTTP 404, saved bytes, and retry.");
} finally {
    if (command && socket.readyState === WebSocket.OPEN) {
        await command("Browser.close").catch(() => {});
    }
    socket?.close();
    if (browser && browser.exitCode === null) {
        browser.kill();
    }
    if (browserExited) {
        await browserExited.catch(() => {});
    }
    if (server) {
        await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 125 });
}
