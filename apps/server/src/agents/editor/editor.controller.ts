import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { buildWorkspaceTree, readWorkspaceFile } from '@repo/editor-agent';
import { WORKSPACE_ROOT } from './workspace-root.js';

/**
 * editor agent 的工作区读取接口：给桌面端画文件树、读文件内容用。
 * 只读，写操作一律通过模型工具（edit_file 等）进行。
 */
@Controller('agent/editor/workspace')
export class EditorController {
  @Get('tree')
  tree() {
    return { root: WORKSPACE_ROOT, nodes: buildWorkspaceTree(WORKSPACE_ROOT) };
  }

  @Get('file')
  file(@Query('path') path: string) {
    if (!path) throw new BadRequestException('path 不能为空');
    try {
      return { path, content: readWorkspaceFile(WORKSPACE_ROOT, path) };
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }
}
