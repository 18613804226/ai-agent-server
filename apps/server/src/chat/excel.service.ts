import { BadRequestException, Injectable } from '@nestjs/common';
import { extname } from 'path';
import {
  checkExcelBuffer,
  ExcelTooLargeError,
  type ExcelCheckOptions,
  type ExcelCheckResult,
} from './excel-check.js';
import { decodeOriginalName } from './filename.js';

/**
 * Excel 错误识别：检查上传的 Excel，返回结构化问题清单。
 * 与知识库/聊天附件完全独立：不落盘、不向量化、不写入任何表。
 */
@Injectable()
export class ExcelService {
  async checkExcelFile(
    file: Express.Multer.File,
    rules?: string,
  ): Promise<ExcelCheckResult> {
    if (!file?.buffer) throw new BadRequestException('没有收到文件');

    const name = decodeOriginalName(file.originalname || '');
    const ext = extname(name).toLowerCase();
    const mime = file.mimetype || '';
    const isExcel =
      ext === '.xlsx' ||
      ext === '.xls' ||
      mime ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/vnd.ms-excel';
    if (!isExcel) {
      throw new BadRequestException(
        `只支持 .xlsx / .xls 文件（收到 ${ext || mime || '未知类型'}）`,
      );
    }

    let parsedRules: ExcelCheckOptions['rules'];
    if (rules?.trim()) {
      try {
        parsedRules = JSON.parse(rules);
      } catch {
        throw new BadRequestException('rules 不是合法 JSON，可省略该字段');
      }
    }

    try {
      const result = await checkExcelBuffer(name, file.buffer, {
        rules: parsedRules,
      });
      return result;
    } catch (e: any) {
      if (e instanceof ExcelTooLargeError) {
        throw new BadRequestException(e.message);
      }
      // exceljs 读不了（加密/损坏/格式不符）时给明确提示，别把内部错误抛给前端
      throw new BadRequestException(
        `Excel 解析失败：${e?.message || '文件可能已加密或损坏'}`,
      );
    }
  }
}
