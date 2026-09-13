/**
 * 统一的学术论文数据模型
 * 支持多个学术平台的标准化数据格式
 */

import { sanitizeBody } from '../utils/SecurityUtils.js';

export interface Paper {
  // === 核心字段 ===
  /** 唯一标识符 (如 arXiv ID, PMID, DOI) */
  paperId: string;
  
  /** 论文标题 */
  title: string;
  
  /** 作者列表 */
  authors: string[];
  
  /** 摘要 */
  abstract: string;
  
  /** DOI (数字对象标识符) */
  doi: string;
  
  /** 发布日期 */
  publishedDate: Date | null;
  
  /** PDF直接下载链接 */
  pdfUrl: string;
  
  /** 论文页面URL */
  url: string;
  
  /** 来源平台 (如 'arxiv', 'pubmed', 'webofscience') */
  source: string;

  // === 可选字段 ===
  /** 最后更新日期 */
  updatedDate?: Date;
  
  /** 学科分类 */
  categories?: string[];
  
  /** 关键词 */
  keywords?: string[];
  
  /** 被引次数 */
  citationCount?: number;
  
  /** 参考文献ID/DOI列表 */
  references?: string[];
  
  /** 期刊/会议名称 */
  journal?: string;
  
  /** 卷号 */
  volume?: string;
  
  /** 期号 */
  issue?: string;
  
  /** 页码范围 */
  pages?: string;
  
  /** 年份 */
  year?: number;
  
  /** 平台特定的额外元数据 */
  extra?: Record<string, any>;
}

/**
 * Paper工厂类，用于创建和验证Paper对象
 */
export class PaperFactory {
  /**
   * 创建Paper对象
   */
  static create(data: Partial<Paper> & Required<Pick<Paper, 'paperId' | 'title' | 'source'>>): Paper {
    return {
      paperId: data.paperId,
      title: data.title,
      authors: data.authors || [],
      abstract: data.abstract || '',
      doi: data.doi || '',
      publishedDate: data.publishedDate || null,
      pdfUrl: data.pdfUrl || '',
      url: data.url || '',
      source: data.source,
      updatedDate: data.updatedDate,
      categories: data.categories || [],
      keywords: data.keywords || [],
      citationCount: data.citationCount,
      references: data.references || [],
      journal: data.journal,
      volume: data.volume,
      issue: data.issue,
      pages: data.pages,
      year: data.year,
      extra: data.extra || {}
    };
  }

  /**
   * 将Paper对象转换为字典格式（用于序列化）
   */
  static toDict(paper: Paper): Record<string, any> {
    return {
      paper_id: paper.paperId,
      title: paper.title,
      authors: paper.authors.join('; '),
      abstract: paper.abstract,
      doi: paper.doi,
      published_date: paper.publishedDate?.toISOString() || '',
      pdf_url: paper.pdfUrl,
      url: paper.url,
      source: paper.source,
      updated_date: paper.updatedDate?.toISOString() || '',
      categories: paper.categories?.join('; ') || '',
      keywords: paper.keywords?.join('; ') || '',
      citation_count: paper.citationCount ?? null,
      references: paper.references?.join('; ') || '',
      journal: paper.journal || '',
      volume: paper.volume || '',
      issue: paper.issue || '',
      pages: paper.pages || '',
      year: paper.year || null,
      extra: JSON.stringify(sanitizeBody(paper.extra || {}))
    };
  }

  /**
   * 验证Paper对象是否有效
   */
  static validate(paper: Paper): boolean {
    return !!(paper.paperId && paper.title && paper.source);
  }
}