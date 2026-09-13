import { Paper, PaperFactory } from '../models/Paper.js';

export type WosRecordView = 'short' | 'full';
export type WosRelation = 'references' | 'citing' | 'related';

export interface WosQueryResult {
  queryId?: string;
  recordsFound?: number;
  recordsSearched?: number;
}

export interface WosReference {
  /** Some entitlement/legacy reference responses omit UID; retain the row. */
  uid?: string;
  doi?: string;
  citedAuthor?: string;
  citedTitle?: string;
  citedWork?: string;
  year?: number;
  page?: number | string;
  timesCited?: number;
}

export interface WosRelationResult<T = Paper | WosReference> {
  queryResult: WosQueryResult;
  items: T[];
}

export interface StarterPages {
  range?: string;
  begin?: string;
  end?: string;
  count?: number;
}

export interface StarterRecord {
  uid: string;
  title?: string;
  types?: string[];
  sourceTypes?: string[];
  source?: {
    sourceTitle?: string;
    publishYear?: number;
    publishMonth?: string;
    volume?: string;
    issue?: string;
    pages?: StarterPages | string;
  };
  names?: {
    authors?: Array<{ displayName?: string }>;
    contributors?: Array<{ displayName?: string }>;
  };
  links?: {
    record?: string;
    citingArticles?: string;
    references?: string;
    related?: string;
  };
  citations?: Array<{ db?: string; count?: number }>;
  identifiers?: { doi?: string };
  keywords?: { authorKeywords?: string[] };
}

export interface StarterResponse {
  metadata?: { total?: number; page?: number; limit?: number };
  hits?: StarterRecord[];
}

export function parseStarterRecord(record: StarterRecord, databaseId = 'WOS', version: 'v1' | 'v2' = 'v2'): Paper | null {
  if (!record?.uid) return null;
  const source = record.source || {};
  const pages = parsePages(source.pages);
  const links = record.links || {};
  const contributors = asArray(record.names?.contributors)
    .map(contributor => textValue(contributor?.displayName))
    .filter(Boolean);
  const authors = asArray(record.names?.authors)
    .map(author => textValue(author?.displayName))
    .filter(Boolean);

  return PaperFactory.create({
    paperId: record.uid,
    title: cleanText(textValue(record.title) || 'No title available'),
    authors,
    abstract: '',
    doi: findDoi(record.identifiers, record),
    publishedDate: parseDate(source.publishYear, textValue(source.publishMonth)),
    pdfUrl: '',
    url: textValue(links.record),
    source: 'webofscience',
    categories: textArray(record.types),
    keywords: textArray(record.keywords?.authorKeywords),
    citationCount: parseStarterCitationCount(record.citations, databaseId),
    journal: textValue(source.sourceTitle),
    volume: textValue(source.volume) || undefined,
    issue: textValue(source.issue) || undefined,
    pages: pageString(pages),
    year: numberValue(source.publishYear),
    extra: {
      uid: record.uid,
      doctype: textArray(record.types)[0],
      sourceTypes: textArray(record.sourceTypes),
      wosVersion: version,
      abstractAvailable: false,
      wosLinks: {
        record: textValue(links.record) || undefined,
        citingArticles: textValue(links.citingArticles) || undefined,
        references: textValue(links.references) || undefined,
        related: textValue(links.related) || undefined
      },
      ...(pages ? { pages } : {}),
      ...(contributors.length ? { contributors } : {})
    }
  });
}

export function parseExpandedRecords(data: any): any[] {
  const recordContainer = data?.Data?.Records?.records?.REC ??
    data?.Data?.Records?.records?.rec ??
    data?.Data?.records?.REC ??
    data?.Data?.records?.rec ??
    data?.data?.Records?.records?.REC ??
    data?.data?.Records?.records?.rec ??
    data?.Records?.records?.REC ??
    data?.Records?.records?.rec;
  return asArray(recordContainer);
}

export function parseQueryResult(data: any): WosQueryResult {
  const result = data?.QueryResult || data?.queryResult || {};
  return {
    queryId: textValue(result.QueryID ?? result.queryId),
    recordsFound: numberValue(result.RecordsFound ?? result.recordsFound),
    recordsSearched: numberValue(result.RecordsSearched ?? result.recordsSearched)
  };
}

export function parseReferences(data: any): WosReference[] {
  const records = data?.Data?.Records?.records?.REC ??
    data?.Data?.Records?.records?.rec ??
    data?.Data?.records?.REC ??
    data?.Data?.records?.rec ??
    data?.data?.Records?.records?.REC ??
    data?.data?.Records?.records?.rec ??
    data?.Records?.records?.REC ??
    data?.Records?.records?.rec ??
    data?.Data ?? data?.data ?? data?.records;
  return asArray(records)
    .map(parseReferenceRecord)
    .filter(reference => Boolean(reference.uid || reference.doi || reference.citedTitle || reference.citedWork));
}

function parseReferenceRecord(record: any): WosReference {
  const staticData = record?.static_data || record?.staticData || {};
  const summary = staticData.summary || {};
  const pubInfo = summary.pub_info || summary.pubInfo || {};
  const fullMetadata = staticData.fullrecord_metadata || staticData.fullRecordMetadata || {};
  const titles = asArray(summary.titles?.title ?? record?.titles?.title);
  const names = asArray(summary.names?.name ?? record?.names?.name);
  const citationCounts = parseCitationCounts(record, staticData);
  const pageValue = record?.page ?? pubInfo.page;
  return {
    uid: textValue(record?.UID ?? record?.uid) || undefined,
    doi: findDoi(record, staticData, fullMetadata) || undefined,
    citedAuthor: textValue(record?.citedAuthor) || names
      .filter(name => !name.role || String(name.role).toLowerCase() === 'author')
      .map(name => textValue(name.display_name ?? name.displayName ?? name.full_name))
      .filter(Boolean).join('; ') || undefined,
    citedTitle: textValue(record?.citedTitle) || firstTitle(titles, ['item', 'title']) || undefined,
    citedWork: textValue(record?.citedWork) || firstTitle(titles, ['source', 'publication', 'so']) ||
      textValue(pubInfo.sourceTitle ?? pubInfo.source_title) || undefined,
    year: numberValue(record?.year ?? pubInfo.pubyear ?? pubInfo.pubYear),
    page: referencePage(pageValue),
    timesCited: numberValue(record?.timesCited ?? record?.times_cited) ?? citationCounts.WOS
  };
}

export function parseExpandedRecord(
  record: any,
  recordView: WosRecordView = 'short',
  databaseId = 'WOS',
  queryResult?: WosQueryResult
): Paper | null {
  const uid = textValue(record?.UID ?? record?.uid);
  if (!uid) return null;

  const staticData = record.static_data || record.staticData || {};
  const summary = staticData.summary || {};
  const pubInfo = summary.pub_info || summary.pubInfo || {};
  const fullMetadata = staticData.fullrecord_metadata || staticData.fullRecordMetadata || {};
  const titles = asArray(summary.titles?.title ?? staticData.item?.titles?.title ?? record.item?.titles?.title);
  const title = firstTitle(titles, ['item', 'title']) || textValue(record.title) || 'No title available';
  const journal = firstTitle(titles, ['source', 'publication', 'so']) ||
    textValue(pubInfo.sourceTitle ?? pubInfo.source_title ?? pubInfo.sourcetitle ?? record.journal) || '';
  const names = asArray(summary.names?.name ?? record.names?.name);
  const authors = names
    .filter(name => !name.role || String(name.role).toLowerCase() === 'author')
    .map(name => textValue(name.display_name ?? name.displayName ?? name.full_name))
    .filter((name): name is string => Boolean(name));
  const contributors = asArray(summary.names?.contributors ?? record.contributors ?? staticData.contributors)
    .map(name => textValue(name?.display_name ?? name?.displayName ?? name?.full_name))
    .filter((name): name is string => Boolean(name));
  const citationCounts = parseCitationCounts(record, staticData);
  const pages = parseExpandedPages(pubInfo.page);
  const links = record.links || staticData.links || {};

  const paper = PaperFactory.create({
    paperId: uid,
    title: cleanText(title),
    authors,
    abstract: cleanText(extractAbstract(fullMetadata.abstracts?.abstract ?? staticData.abstracts?.abstract)),
    doi: findDoi(record, staticData, fullMetadata),
    publishedDate: parseExpandedDate(pubInfo.coverdate ?? pubInfo.coverDate, pubInfo.pubyear ?? pubInfo.pubYear),
    pdfUrl: '',
    url: textValue(links.record ?? links.Record),
    source: 'webofscience',
    categories: textArray(summary.doctypes?.doctype ?? fullMetadata.normalized_doctypes?.doctype),
    keywords: textArray(fullMetadata.keywords?.keyword ?? fullMetadata.keywords?.keywords),
    citationCount: citationCounts[databaseId.toUpperCase()],
    journal: cleanText(journal),
    volume: textValue(pubInfo.vol ?? pubInfo.volume) || undefined,
    issue: textValue(pubInfo.issue) || undefined,
    pages: pages?.range || pages?.begin || undefined,
    year: numberValue(pubInfo.pubyear ?? pubInfo.pubYear),
    extra: {
      uid,
      wosVersion: 'expanded',
      recordView,
      citationCounts,
      wosQueryResult: queryResult || {}
    }
  });

  if (contributors.length) paper.extra = { ...paper.extra, contributors };
  if (pages) paper.extra = { ...paper.extra, pages };
  paper.extra = {
    ...paper.extra,
    wosLinks: {
      record: textValue(links.record ?? links.Record) || undefined,
      citingArticles: textValue(links.citingArticles) || undefined,
      references: textValue(links.references) || undefined,
      related: textValue(links.related) || undefined
    }
  };
  return paper;
}

function parseStarterCitationCount(citations: StarterRecord['citations'], databaseId: string): number | undefined {
  const citation = asArray(citations).find(item => textValue(item?.db).toUpperCase() === databaseId.toUpperCase());
  return numberValue(citation?.count);
}

function parseCitationCounts(record: any, staticData: any): Record<string, number> {
  const values = asArray(record?.dynamic_data?.citation_related?.tc_list?.silo_tc ??
    record?.dynamicData?.citationRelated?.tcList?.siloTc ??
    staticData?.dynamic_data?.citation_related?.tc_list?.silo_tc);
  const counts: Record<string, number> = {};
  for (const value of values) {
    const collection = textValue(value?.coll_id ?? value?.collId);
    const count = numberValue(value?.local_count ?? value?.localCount ?? value?.count);
    if (collection && count !== undefined) counts[collection.toUpperCase()] = count;
  }
  return counts;
}

function textArray(value: any): string[] {
  return asArray(value).map(item => textValue(item)).filter(Boolean);
}

function referencePage(value: any): number | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    return textValue(value.content ?? value.range ?? value.begin ?? value.end) || undefined;
  }
  const text = textValue(value);
  const numeric = Number(text);
  return Number.isFinite(numeric) && text !== '' ? numeric : text || undefined;
}

function parsePages(value: StarterPages | string | undefined): StarterPages | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? { range: value } : value;
}

function pageString(pages?: StarterPages): string | undefined {
  if (!pages) return undefined;
  return pages.range || (pages.begin && pages.end ? `${pages.begin}-${pages.end}` : pages.begin || pages.end);
}

function parseExpandedPages(value: any): StarterPages | undefined {
  if (!value) return undefined;
  if (typeof value === 'string' || typeof value === 'number') return { range: String(value) };
  const begin = textValue(value.begin);
  const end = textValue(value.end);
  return {
    range: textValue(value.content ?? value.range) || (begin && end ? `${begin}-${end}` : begin || end || undefined),
    begin: begin || undefined,
    end: end || undefined,
    count: numberValue(value.page_count ?? value.count)
  };
}

function parseDate(yearValue: unknown, monthValue?: string): Date | null {
  const year = numberValue(yearValue);
  if (year === undefined) return null;
  const month = monthNumber(monthValue);
  return new Date(Date.UTC(year, month, 1));
}

function parseExpandedDate(coverDate: unknown, yearValue: unknown): Date | null {
  const year = numberValue(yearValue) || numberValue(typeof coverDate === 'string' ? coverDate.match(/\b(\d{4})\b/)?.[1] : undefined);
  if (year === undefined) return null;
  return new Date(Date.UTC(year, monthNumber(typeof coverDate === 'string' ? coverDate : undefined), 1));
}

function monthNumber(value?: string): number {
  const text = (value || '').trim();
  const named = ({ JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 } as Record<string, number>)[text.slice(0, 3).toUpperCase()];
  if (named !== undefined) return named;
  const numeric = text.match(/(?:^|[-/\s])0?([1-9]|1[0-2])(?:$|[-/\s])/);
  return numeric ? Number(numeric[1]) - 1 : 0;
}

function firstTitle(values: any[], preferredTypes: string[]): string | undefined {
  const normalized = preferredTypes.map(type => type.toLowerCase());
  const preferred = values.find(value => normalized.includes(textValue(value?.type).toLowerCase()));
  return textValue(preferred?.content ?? preferred?.value ?? preferred?.title) ||
    textValue(values[0]?.content ?? values[0]?.value ?? values[0]?.title) || undefined;
}

function extractAbstract(value: any): string {
  return asArray(value)
    .flatMap(item => asArray(
      item?.abstract_text?.p ?? item?.abstractText?.p ?? item?.p ??
      item?.content ?? item?.value ?? item?.abstract
    ))
    .map(item => textValue(item))
    .filter(Boolean)
    .join(' ');
}

function findDoi(...values: any[]): string {
  const direct = values.map(value => textValue(value?.doi ?? value?.DOI)).find(value => Boolean(value));
  if (direct) return direct;
  const identifiers: any[] = [];
  for (const value of values) {
    identifiers.push(...asArray(value?.cluster_related?.identifiers?.identifier));
    identifiers.push(...asArray(value?.clusterRelated?.identifiers?.identifier));
    identifiers.push(...asArray(value?.dynamic_data?.cluster_related?.identifiers?.identifier));
    identifiers.push(...asArray(value?.dynamicData?.clusterRelated?.identifiers?.identifier));
    identifiers.push(...asArray(value?.fullrecord_metadata?.identifiers?.identifier));
    identifiers.push(...asArray(value?.identifiers?.identifier));
  }
  const identifierDoi = identifiers
    .filter(identifier => /doi/i.test(textValue(identifier?.type ?? identifier?.idtype ?? identifier?.name)))
    .map(identifier => textValue(identifier?.value ?? identifier?.content ?? identifier?.id ?? identifier))
    .find(value => /^10\.\d{4,}\/\S+/i.test(value));
  return identifierDoi || findDoiInObject(values, 0) || '';
}

function findDoiInObject(value: any, depth: number): string | undefined {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return /^10\.\d{4,}\/\S+$/i.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDoiInObject(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/doi/i.test(key) && /^10\.\d{4,}\/\S+$/i.test(textValue(child))) return textValue(child);
      const found = findDoiInObject(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function textValue(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') return textValue(value.content ?? value.value ?? value.text ?? value.name);
  return '';
}

function numberValue(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
