/**
 * 修正 multipart 传输中的文件名乱码，覆盖两种常见客户端行为：
 *   1) 把 UTF-8 字节百分号编码后填到 filename 里（如 %E6%B5%8B%E8%AF%95.docx）；
 *   2) busboy 默认按 latin1 解析 filename，把浏览器发的 UTF-8 字节错解成乱码。
 */
export function decodeOriginalName(name: string): string {
  if (!name) return name;

  // 情况 1：百分号 URL 编码。仅在解码后真的出现非 ASCII 时才信任，
  // 这样 "50%.pdf"（百分号后非法）这样的合法名字不会被损坏。
  if (/%[0-9A-Fa-f]{2}/.test(name)) {
    try {
      const decoded = decodeURIComponent(name);
      // 仅当译码后真的含非 ASCII 字符时才信任，避开 "50%.pdf" 这类合法百分号
      let hasNonAscii = false;
      for (let i = 0; i < decoded.length; i++) {
        if (decoded.charCodeAt(i) > 0x7f) {
          hasNonAscii = true;
          break;
        }
      }
      if (hasNonAscii) return decoded;
    } catch {
      // 译码失败，保留原值，走情况 2 继续判断
    }
  }

  // 情况 2：全字符 ≤0xFF 且含高位字节 → 判定为 latin1 错解；
  //          若含 >0xFF 字符，说明已是正确 Unicode，直接返回。
  let hasHighByte = false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c > 0xff) return name;
    if (c >= 0x80) hasHighByte = true;
  }
  if (!hasHighByte) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(name, 'latin1'),
    );
  } catch {
    return name;
  }
}
