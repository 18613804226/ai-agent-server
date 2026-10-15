# Backlog: OCR for scanned-document attachments

## 背景

`POST /chat/attachment` 走 `extractDocumentText`（pdf-parse / mammoth / word-extractor）。
对**扫描版/纯图片 PDF / 图片型 word**，这些库只能拿到零散 metadata（如 18 字标题），正文几乎是位图，
因此 `text` 会很短甚至为空，导致：

- 短文本（如 18 字）被注入 prompt → 模型答非所问。
- 长期抛出 `没能从 xxx 解析出文字（可能是扫描版图片型文档，暂无 OCR）`。

目前仅做空判定 (`!text`) 退出来 400，无法真正解析扫描件。

## 诉求

当 `pdf-parse`/`mammoth` 等纯文本提取**提取字数过少或全为空**时，自动降级到 OCR：
- PDF：转页为图 → 逐页 OCR → 拼接回 `text`。
- Word/图片：直接 OCR 图片/嵌入图片流。

## 方案参考

- **pdf** → `pdf2pic` / `pdf-lib` 转页为 PNG 500dpi → OCR。
- **OCR 引擎**：
  - `tesseract.js`（浏览器/Node 通用，模型轻，首次冷启动稍慢）。
  - 或调用已有的 ASR/视觉大模型做 OCR（复用 Zhipu/GLM 视觉接口，减少新增依赖）。
- **兜底**：OCR 结果仍为空 → 退回老 400 提示；避免把纯二进制扔给 OCR 烧钱。

## 接入点

- `src/chat/document-text.ts` — `extractDocumentText` 返回一个新字段 `textType?: 'native' | 'ocr'`，便于统计/计费。
- `src/chat/chat.service.ts` — `parseChatAttachment` 文档分支在 `!text` 后尝试 OCR。

## 验收

- 扫描版 PDF 能返回 >100 字有效文字。
- 普通文字 PDF 仍走原始解析路径（不额外 OCR，不增加耗时）。
- OCR 耗时/失败不阻塞主流程；失败仍 400。

## 优先级

P2（体验坑位，但不影响正常文字文档）。
