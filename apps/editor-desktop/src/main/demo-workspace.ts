import { app } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/** 内置演示工作区内容（仅在文件不存在时写入，不覆盖用户改动） */
const DEMO_FILES: Record<string, string> = {
  'README.md': `# 演示文件夹

这是应用内置的演示工作区，可以随意查看、修改或删除。

- \`hello.go\` / \`hello.py\` / \`Hello.java\`：几个语言的最小示例
- \`README.md\`：本说明

点击左侧「打开文件夹」并选择此目录，即可把它作为工作区打开。
`,
  'hello.go': `package main

import "fmt"

func main() {
	fmt.Println("你好，Go！")
}
`,
  'hello.py': `def main():
    print("你好，Python！")


if __name__ == "__main__":
    main()
`,
  'Hello.java': `public class Hello {
    public static void main(String[] args) {
        System.out.println("你好，Java！");
    }
}
`,
};

/**
 * 首次启动生成内置演示文件夹（userData/demo-workspace）。
 * 只补建缺失文件，不覆盖用户已修改的内容；失败不影响应用启动。
 */
export function ensureDemoWorkspace(): string {
  const dir = join(app.getPath('userData'), 'demo-workspace');
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(DEMO_FILES)) {
      const file = join(dir, name);
      if (!existsSync(file)) writeFileSync(file, content, 'utf8');
    }
  } catch (e) {
    console.error('[demo-workspace] 生成失败:', e);
  }
  return dir;
}
