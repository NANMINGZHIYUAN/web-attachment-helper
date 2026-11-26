# 网页附件助手

一个用于整理网页附件的油猴脚本。通过 Tampermonkey 菜单打开面板，查看当前网页明确标记供下载的附件，逐项或批量保存。

## 安装与使用

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)，打开[脚本安装页](https://raw.githubusercontent.com/NANMINGZHIYUAN/web-attachment-helper/main/web-attachment-helper.user.js)并确认安装。
2. 打开有附件下载入口的 HTTPS 网页，点浏览器工具栏里的 Tampermonkey 图标，选择「网页附件助手」。
3. 下载单项，或点「下载全部」逐个处理附件。页面附件变化后，可以在面板里重新扫描。遇到失败时，可以查看状态并重试该项。

Chrome 或 Edge 如果拦截了脚本运行，可按 [Tampermonkey 的说明](https://www.tampermonkey.net/faq.php?q=Q209)开启「允许用户脚本」。多文件保存由浏览器的下载设置决定，面板显示「已交给浏览器」后可在浏览器的下载记录里查看保存结果。

## 识别范围

- 读取当前顶层网页中带 `download` 属性的同源 HTTP(S) 链接。相同资源地址只显示一次，保留查询参数。
- 支持 HTTPS 网页和本机 HTTP 演示。下载请求沿用浏览器的同源访问规则，遇到重定向时会报告失败。
- 每次读取一个完整文件，再交给浏览器保存。单个文件读取超时为 120 秒。大文件建议直接使用页面原有的下载入口。

## 本地演示

需要 Node.js 22 或以上版本。克隆仓库后，在项目根目录运行：

```sh
node demo/server.mjs
```

在浏览器打开 `http://127.0.0.1:4173/demo/`，并从 Tampermonkey 菜单打开面板。列表应显示三个附件。点「下载全部」后，`missing.txt` 显示 HTTP 404，`notes.txt` 和 `checklist.txt` 会交给浏览器保存。示例文件由本地服务生成。

## 浏览器测试

```sh
node --check web-attachment-helper.user.js
node test/smoke.mjs
```

测试使用无头 Chromium 和独立的临时配置，模拟 Tampermonkey 菜单入口，检查附件筛选、去重、批处理失败隔离和下载文件内容。可用环境变量 `CHROME_PATH` 指定 Chromium、Chrome 或 Edge 的可执行文件。

## 交流与许可

欢迎在 [GitHub Issues](https://github.com/NANMINGZHIYUAN/web-attachment-helper/issues) 分享复现步骤、浏览器版本和可公开的示例。代码采用 [MIT 许可证](LICENSE)。
