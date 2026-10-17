import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BrowserDocument, BrowserSearchResult } from "@shared/browser-types";
import { documentToMarkdown } from "./browser-markdown";
import { BrowserIndex, type BrowserRelatedPage } from "./browser-index";
import { assertAllowedPath } from "../security/path-policy";

export interface BrowserArtifactSaveInput {
  projectId?: string | null;
  document: BrowserDocument;
  format: "json" | "markdown" | "text";
  destinationPath?: string;
}

export interface BrowserArtifactSearchInput {
  projectId?: string | null;
  query: string;
  host?: string;
  crawlId?: string;
  limit?: number;
}

/**
 * Persistent browser artifact store. Markdown-only by default (json only when
 * the caller explicitly asks for format:"json"), sha256-deduped (content same
 * → only fetched_at updates, no file rewrite), and backed by a trigram FTS5
 * index for chunk-level search. ponytail: one md file per page; the index is
 * the source of truth for search, the file is the source of truth for content.
 */
export class BrowserArtifactStore {
  private readonly index: BrowserIndex;

  constructor(private readonly userDataPath: string) {
    this.index = new BrowserIndex(join(userDataPath, "browser-index.sqlite"));
  }

  /** Release the SQLite handle (app shutdown / tests). Safe to call twice. */
  close(): void { this.index.close(); }

  async save(input: BrowserArtifactSaveInput): Promise<string> {
    const host = sanitizeSegment(new URL(input.document.source.finalUrl).hostname || "page");
    const directory = input.destinationPath
      ? resolve(input.destinationPath)
      : join(this.userDataPath, "browser-cache", host);
    if (input.destinationPath && !isAbsolute(input.destinationPath)) throw new Error("Browser artifact destination must be absolute.");
    // A caller-supplied destination is still confined to the cache root: saveExtraction is
    // reachable from the token-gated agent API, so an unchecked path is an arbitrary file write.
    if (input.destinationPath) await assertAllowedPath(directory, { roots: [this.userDataPath], mustExist: false });
    await mkdir(directory, { recursive: true });
    const sha256 = createHash("sha256").update(input.document.text).digest("hex");
    const projectId = input.projectId === undefined ? null : input.projectId;
    const existing = this.index.findByUrl(input.document.source.finalUrl);
    if (existing && existing.sha256 === sha256 && !input.destinationPath) {
      // Content unchanged — refresh fetched_at only, don't rewrite the file.
      this.index.upsertPage({
        url: input.document.source.finalUrl, host, title: input.document.source.title,
        sha256, mdPath: existing.mdPath, textLen: input.document.text.length,
        projectId, document: input.document,
      });
      return existing.mdPath;
    }
    const slug = sanitizeSegment(input.document.source.title || "page").slice(0, 80) || "page";
    const stem = existing?.id ?? `${slug}-${randomUUID().slice(0, 8)}`;
    const markdownPath = join(directory, `${stem}.md`);
    const jsonPath = join(directory, `${stem}.json`);
    await writeFile(markdownPath, documentToMarkdown(input.document), "utf8");
    if (input.format === "json") {
      await writeFile(jsonPath, JSON.stringify(input.document, null, 2), "utf8");
    }
    this.index.upsertPage({
      url: input.document.source.finalUrl, host, title: input.document.source.title,
      sha256, mdPath: markdownPath, textLen: input.document.text.length,
      projectId, document: input.document,
    });
    return input.format === "json" ? jsonPath : markdownPath;
  }

  /**
   * Persist a page screenshot under the same host-scoped cache root as text
   * artifacts. Deliberately not indexed (FTS is text-only) and not deduped —
   * every capture of a page is a distinct point-in-time record.
   */
  async saveScreenshot(input: { data: Buffer; pageUrl: string; title: string; extension?: "png" | "jpeg" }): Promise<string> {
    let host = "page";
    try {
      host = new URL(input.pageUrl).hostname || "page";
    } catch { /* non-URL pages (about:blank) fall through to "page" */ }
    const directory = join(this.userDataPath, "browser-cache", sanitizeSegment(host));
    await mkdir(directory, { recursive: true });
    const slug = sanitizeSegment(input.title || "screenshot").slice(0, 60) || "screenshot";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(directory, `${slug}-${stamp}-${randomUUID().slice(0, 8)}.${input.extension ?? "png"}`);
    await writeFile(path, input.data);
    return path;
  }

  async addDocument(projectId: string | null, document: BrowserDocument, paths?: { markdownPath?: string; jsonPath?: string }, _crawlId?: string): Promise<void> {
    const host = sanitizeSegment(new URL(document.source.finalUrl).hostname || "page");
    const sha256 = createHash("sha256").update(document.text).digest("hex");
    const existing = this.index.findByUrl(document.source.finalUrl);
    if (existing && existing.sha256 === sha256 && !paths) {
      this.index.upsertPage({
        url: document.source.finalUrl, host, title: document.source.title,
        sha256, mdPath: existing.mdPath, textLen: document.text.length,
        projectId, document,
      });
      return;
    }
    const markdownPath = paths?.markdownPath ?? join(this.userDataPath, "browser-cache", host, `${existing?.id ?? randomUUID().slice(0, 8)}.md`);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, documentToMarkdown(document), "utf8");
    if (paths?.jsonPath) {
      await mkdir(dirname(paths.jsonPath), { recursive: true });
      await writeFile(paths.jsonPath, JSON.stringify(document, null, 2), "utf8");
    }
    this.index.upsertPage({
      url: document.source.finalUrl, host, title: document.source.title,
      sha256, mdPath: markdownPath, textLen: document.text.length,
      projectId, document,
    });
  }

  search(input: BrowserArtifactSearchInput): BrowserSearchResult[] {
    return this.index.search({
      query: input.query,
      ...(input.host ? { host: input.host } : {}),
      ...(input.projectId !== undefined && input.projectId !== null ? { projectId: input.projectId } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  related(input: { url?: string; pageId?: string; sameHostOnly?: boolean; limit?: number }): BrowserRelatedPage[] {
    return this.index.related(input);
  }

  async read(path: string): Promise<string> {
    const resolved = resolve(path);
    const rel = relative(this.userDataPath, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Browser artifact is outside the allowed workspace.");
    return readFile(resolved, "utf8");
  }
}

function sanitizeSegment(value: string): string {
  return basename(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}
