// ==UserScript==
// @name         网页附件助手
// @namespace    https://github.com/NANMINGZHIYUAN/web-attachment-helper
// @version      0.1.0
// @description  列出页面明确标记的同源下载链接，支持去重和批量下载。
// @author       NANMINGZHIYUAN
// @license      MIT
// @supportURL   https://github.com/NANMINGZHIYUAN/web-attachment-helper/issues
// @match        https://*/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
    "use strict";

    if (window !== window.top) return;

    const downloadTimeout = 120_000;
    const objectUrlLifetime = 5_000;
    const statusLabels = {
        pending: "待下载",
        downloading: "正在读取文件",
        submitted: "已交给浏览器",
        failed: "失败",
    };
    let panel;
    let attachments = [];
    let scannedPage;
    let running = false;

    function filenameFor(link, url) {
        let basename = url.pathname.split("/").pop();
        try {
            basename = decodeURIComponent(basename);
        } catch {
            // Keep the literal name if the path contains malformed escapes.
        }
        const suggestedName = link.getAttribute("download").trim() || basename || link.textContent.trim();
        let name = suggestedName
            .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "_")
            .replace(/^[.\s]+|[.\s]+$/g, "");
        if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
        return name || "附件";
    }

    function scanAttachments() {
        const found = new Map();
        for (const link of document.querySelectorAll("a[href][download]")) {
            const href = link.getAttribute("href").trim();
            if (!href || href.startsWith("#")) continue;
            let url;
            try {
                url = new URL(href, document.baseURI);
            } catch {
                continue;
            }
            if ((url.protocol !== "http:" && url.protocol !== "https:") ||
                url.origin !== location.origin || url.username || url.password) continue;

            url.hash = "";
            if (!found.has(url.href)) found.set(url.href, filenameFor(link, url));
        }
        return found;
    }

    function element(tag, text = "", className = "") {
        const node = document.createElement(tag);
        node.textContent = text;
        node.className = className;
        return node;
    }

    function button(action, label, onClick) {
        const node = element("button", label);
        node.type = "button";
        node.dataset.action = action;
        node.addEventListener("click", onClick);
        return node;
    }

    function createPanel() {
        const host = element("div");
        host.id = "web-attachment-helper";
        const root = host.attachShadow({ mode: "open" });
        const dialog = element("dialog");
        dialog.setAttribute("aria-labelledby", "attachment-title");
        dialog.setAttribute("aria-describedby", "attachment-summary");

        const heading = element("h2", "网页附件助手");
        heading.id = "attachment-title";
        const close = button("close", "关闭", () => dialog.close());
        const header = element("header");
        header.append(heading, close);

        const summary = element("p", "", "summary");
        summary.id = "attachment-summary";
        summary.setAttribute("role", "status");
        const list = element("ul", "", "attachments");
        list.setAttribute("aria-label", "附件列表");

        const rescan = button("rescan", "重新扫描", refreshAttachments);
        const downloadAll = button("download-all", "下载全部", () => {
            void downloadQueue(attachments.filter((attachment) => attachment.statusName !== "submitted"));
        });
        const toolbar = element("div", "", "toolbar");
        toolbar.append(rescan, downloadAll);
        dialog.append(header, summary, list, toolbar);

        const style = element("style", `
            :host { all: initial; color-scheme: light; }
            dialog {
                box-sizing: border-box;
                width: min(34rem, calc(100vw - 2rem));
                max-height: calc(100vh - 2rem);
                padding: 1.25rem;
                border: 1px solid #cad8d4;
                border-radius: .875rem;
                box-shadow: 0 1rem 3rem #102a2540;
                background: #fff;
                color: #182e28;
                font: 1rem/1.5 system-ui, sans-serif;
            }
            dialog::backdrop { background: #142c2766; }
            header, .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
            header { justify-content: space-between; }
            h2 { margin: 0; font-size: 1.25rem; }
            .summary { margin: .75rem 0; color: #465e57; }
            .attachments { margin: 0; padding: 0; list-style: none; }
            .attachment {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                align-items: center;
                gap: .75rem;
                padding: .625rem 0;
                border-top: 1px solid #dce7e3;
            }
            .attachment-name { display: block; font-weight: 600; overflow-wrap: anywhere; }
            .attachment-status { display: block; color: #465e57; font-size: .875rem; }
            .attachment[data-status="failed"] .attachment-status { color: #9a2c24; }
            .toolbar { justify-content: flex-end; margin-top: .75rem; }
            button {
                padding: .375rem .75rem;
                border: 1px solid #afc7bf;
                border-radius: .4rem;
                background: #f5faf8;
                color: #174c3e;
                font: inherit;
                cursor: pointer;
            }
            button:focus-visible { outline: 2px solid #126b54; outline-offset: 2px; }
            [data-action="download-all"] { border-color: #176650; background: #176650; color: #fff; }
            button:disabled { opacity: .6; cursor: default; }
        `);
        root.append(style, dialog);
        document.documentElement.append(host);
        return { dialog, list, summary, rescan, downloadAll };
    }

    function createAttachment(url, name) {
        const title = element("span", name, "attachment-name");
        const status = element("span", statusLabels.pending, "attachment-status");
        const detail = element("div");
        detail.append(title, status);
        const row = element("li", "", "attachment");
        const download = button("download-one", "下载", () => { void downloadQueue([attachment]); });
        download.setAttribute("aria-label", `下载 ${name}`);
        row.append(detail, download);
        row.dataset.status = "pending";
        const attachment = { url, name, row, status, download, statusName: "pending" };
        return attachment;
    }

    function updateControls() {
        let submitted = 0;
        let failed = 0;
        for (const attachment of attachments) {
            const isSubmitted = attachment.statusName === "submitted";
            attachment.download.disabled = running || isSubmitted;
            submitted += Number(isSubmitted);
            failed += Number(attachment.statusName === "failed");
        }
        panel.rescan.disabled = running;
        panel.downloadAll.disabled = running || submitted === attachments.length;
        const sentences = [attachments.length
            ? `找到 ${attachments.length} 个附件。`
            : "未找到当前网页明确标记的同源下载链接。"];
        if (submitted) sentences.push(`${submitted} 个已交给浏览器。`);
        if (failed) sentences.push(`${failed} 个失败。`);
        panel.summary.textContent = sentences.join("");
    }

    function refreshAttachments() {
        if (running) return;
        scannedPage = location.href;
        attachments = Array.from(scanAttachments(), ([url, name]) => createAttachment(url, name));
        panel.list.replaceChildren(...attachments.map((attachment) => attachment.row));
        updateControls();
    }

    function setStatus(attachment, statusName, message = "") {
        attachment.statusName = statusName;
        attachment.row.dataset.status = statusName;
        attachment.status.textContent = message ? `${statusLabels[statusName]}（${message}）` : statusLabels[statusName];
        const action = statusName === "failed" ? "重试" : "下载";
        attachment.download.textContent = action;
        attachment.download.setAttribute("aria-label", `${action} ${attachment.name}`);
        updateControls();
    }

    async function submitDownload(attachment) {
        const response = await fetch(attachment.url, {
            mode: "same-origin",
            credentials: "same-origin",
            redirect: "error",
            signal: AbortSignal.timeout(downloadTimeout),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const objectUrl = URL.createObjectURL(await response.blob());
        const link = element("a");
        link.href = objectUrl;
        link.download = attachment.name;
        link.hidden = true;
        try {
            panel.dialog.append(link);
            link.click();
        } finally {
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), objectUrlLifetime);
        }
    }

    async function downloadQueue(queue) {
        if (running || !queue.length) return;
        if (scannedPage !== location.href) {
            refreshAttachments();
            return;
        }
        const currentLinks = scanAttachments();
        running = true;
        updateControls();
        try {
            for (const attachment of queue) {
                if (!currentLinks.has(attachment.url) || scannedPage !== location.href) {
                    setStatus(attachment, "failed", "页面链接已变更，请重新扫描");
                    continue;
                }
                setStatus(attachment, "downloading");
                try {
                    await submitDownload(attachment);
                    setStatus(attachment, "submitted");
                } catch (error) {
                    let message = error.message;
                    if (error.name === "TimeoutError") message = "请求超时";
                    if (error instanceof TypeError) message = "请求失败或链接发生跳转";
                    setStatus(attachment, "failed", message);
                }
            }
        } finally {
            running = false;
            updateControls();
        }
    }

    GM_registerMenuCommand("网页附件助手", () => {
        if (!panel) panel = createPanel();
        if (scannedPage !== location.href) refreshAttachments();
        if (!panel.dialog.open) panel.dialog.showModal();
    });
})();
