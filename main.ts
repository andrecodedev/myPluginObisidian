import {
  App,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  requestUrl,
} from "obsidian";
import { randomBytes, createHash } from "crypto";
import * as http from "http";
import { shell } from "electron";

/** Resposta minimalista compatível com o uso antigo de fetch no código Google API. */
interface GoogleHttpResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

const FRONTMATTER_DOC_ID_KEY = "google_doc_id";
const FRONTMATTER_DOC_URL_KEY = "google_doc_url";
const FRONTMATTER_DOC_TAB_ID_KEY = "google_doc_tab_id";
const FRONTMATTER_LAST_SYNCED_REVISION_KEY = "google_doc_last_synced_revision_id";
const FRONTMATTER_LAST_SYNCED_HASH_KEY = "google_doc_last_synced_content_hash";
/** Marca nota como mapa local do Obsidian (nunca é guia / não sobe pro Docs). */
const FRONTMATTER_HUB_MAPA_KEY = "gdocs_hub_mapa";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DOCS_API_URL = "https://docs.googleapis.com/v1/documents";
const OAUTH_SCOPE = [
  "https://www.googleapis.com/auth/documents",
  // Drive completo: move Docs existentes pra pasta do hub (drive.file so controla arquivos criados pelo app)
  "https://www.googleapis.com/auth/drive",
].join(" ");
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_SCOPE_FILE_ONLY = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const GOOGLE_DRIVE_UPLOAD_API_URL = "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DRIVE_API_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
/** Pasta raiz no Drive onde cada Doc ganha uma subpasta com o Doc + imagens do Publish. */
const DRIVE_HUB_ROOT_FOLDER_NAME = "Google Docs Hub";
// Pasta de midia sem underscore: "_" no Markdown vira italico e corrompe !_gdocs_media/...
const GDOCS_MEDIA_FOLDER = "gdocs-media";
const GDOCS_MEDIA_FOLDER_LEGACY = "_gdocs_media";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;
const FRONTMATTER_BLOCK_PATTERN = /^---\n[\s\S]*?\n---\n/;

interface GoogleDocsHubSettings {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  /** Escopos do ultimo Connect (pra saber se Drive ja foi autorizado). */
  grantedScopes?: string;
  /**
   * Cache: sha256 do binario da imagem → Drive file id.
   * Evita re-upload no Publish (cada Publish limpava o Doc e subia PNG de novo).
   */
  driveImageCache?: Record<string, string>;
}

const DEFAULT_SETTINGS: GoogleDocsHubSettings = {
  clientId: "",
  clientSecret: "",
  driveImageCache: {},
};

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  grantedScopes?: string;
}

interface InlineToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
  color?: string;
  /** Marca-texto / highlight do Google Docs (backgroundColor do textRun). */
  highlight?: string;
  fontFamily?: string;
  fontSizePt?: number;
}

// Parseia o atributo style="" de um <span> (color, font-family, font-size, background)
function parseCssStyleAttr(style: string): {
  color?: string;
  highlight?: string;
  fontFamily?: string;
  fontSizePt?: number;
} {
  const result: {
    color?: string;
    highlight?: string;
    fontFamily?: string;
    fontSizePt?: number;
  } = {};
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const val = part.slice(colon + 1).trim();
    if (key === "color" && /^#[0-9a-fA-F]{6}$/i.test(val)) {
      result.color = val.toLowerCase();
    } else if ((key === "background-color" || key === "background") && /^#[0-9a-fA-F]{6}/i.test(val)) {
      const hex = /^#[0-9a-fA-F]{6}/i.exec(val)?.[0];
      if (hex) result.highlight = hex.toLowerCase();
    } else if (key === "font-family" && val) {
      result.fontFamily = val.replace(/^["']|["']$/g, "").trim();
    } else if (key === "font-size") {
      const pt = /^(\d+(?:\.\d+)?)pt$/i.exec(val);
      if (pt) result.fontSizePt = parseFloat(pt[1]);
    }
  }
  return result;
}

function wrapWithStyleSpan(
  piece: string,
  opts: { color?: string; highlight?: string; fontFamily?: string; fontSizePt?: number }
): string {
  const styles: string[] = [];
  if (opts.fontFamily) styles.push(`font-family:${opts.fontFamily}`);
  if (opts.fontSizePt != null) styles.push(`font-size:${opts.fontSizePt}pt`);
  if (opts.color) styles.push(`color:${opts.color}`);
  if (opts.highlight) styles.push(`background-color:${opts.highlight}`);
  if (styles.length === 0) return piece;
  return `<span style="${styles.join(";")}">${piece}</span>`;
}

// Converte { red, green, blue } (0 a 1, formato da API do Docs) pra "#rrggbb"
function rgbColorToHex(rgbColor: { red?: number; green?: number; blue?: number }): string {
  const toHex = (value: number | undefined) => Math.round((value ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${toHex(rgbColor.red)}${toHex(rgbColor.green)}${toHex(rgbColor.blue)}`;
}

// Converte "#rrggbb" de volta pro formato { red, green, blue } (0 a 1) que a API do Docs espera
function hexToRgbColor(hex: string): { red: number; green: number; blue: number } {
  const clean = hex.replace("#", "");
  return {
    red: parseInt(clean.slice(0, 2), 16) / 255,
    green: parseInt(clean.slice(2, 4), 16) / 255,
    blue: parseInt(clean.slice(4, 6), 16) / 255,
  };
}

interface ParagraphSpacing {
  spaceAbovePt?: number;
  spaceBelowPt?: number;
  lineSpacing?: number; // 100 = simples, 115 = 1,15 (padrao do Docs)
}

interface TableCellData {
  text: string;
  backgroundColor?: string; // "#rrggbb" do tableCellStyle do Docs
  /** Borda “de destaque” (mais grossa ou colorida) — Obsidian HTML nao tem 4 bordas independentes. */
  borderColor?: string;
  borderWidthPt?: number;
  monospace?: boolean; // caixa de codigo 1x1
}

type MarkdownBlock =
  | { type: "heading"; level: number; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "bullet"; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "checkbox"; checked: boolean; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "numbered"; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "paragraph"; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "image"; path: string } // ![[path]] ou ![](path) — Publish sobe pro Doc via Drive
  | { type: "code"; text: string; language?: string }
  | { type: "table"; rows: TableCellData[][] } // HTML/GFM com cor de fundo por celula
  | { type: "callout"; title: string; body: string } // caixa 1x1 tipo "Por que IO?" / dica
  | { type: "hr" } // --- sob o titulo → borderBottom no Google Docs
  | { type: "blank" };

type ListKind = "checkbox" | "ordered" | "bullet";
type DocListKind = ListKind;

const HEADING_NAMED_STYLES = ["HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"];
const MONOSPACE_FONT_FAMILY = "Courier New";
// Prefixo do Named Range usado pra guardar, de forma invisivel no Doc, qual era a linguagem do bloco de codigo
const CODE_LANGUAGE_NAMED_RANGE_PREFIX = "code-lang:";
// Espacamento tipico do Google Docs com "Adicionar espaco apos item de lista".
// createParagraphBullets zera spaceBelow se vier depois — por isso o Publish aplica
// espacamento num lote SEPARADO, depois das bullets. Minimo 18pt pra nao ficar "grudado".
const DEFAULT_LIST_SPACING: ParagraphSpacing = { spaceBelowPt: 18, lineSpacing: 115 };
const MIN_LIST_SPACE_BELOW_PT = 18;
const GDOCS_SPACING_COMMENT_RE = /<!--\s*gdocs-spacing\s+([^>]*)-->\s*$/;

function parseSpacingComment(line: string): { line: string; spacing?: ParagraphSpacing } {
  const match = GDOCS_SPACING_COMMENT_RE.exec(line);
  if (!match) return { line };
  const spacing: ParagraphSpacing = {};
  const sa = /\bsa="([\d.]+)"/.exec(match[1]);
  const sb = /\bsb="([\d.]+)"/.exec(match[1]);
  const ls = /\bls="([\d.]+)"/.exec(match[1]);
  if (sa) spacing.spaceAbovePt = parseFloat(sa[1]);
  if (sb) spacing.spaceBelowPt = parseFloat(sb[1]);
  if (ls) spacing.lineSpacing = parseFloat(ls[1]);
  return { line: line.replace(GDOCS_SPACING_COMMENT_RE, "").trimEnd(), spacing };
}

function formatSpacingComment(spacing: ParagraphSpacing): string {
  const parts: string[] = [];
  if (spacing.spaceAbovePt != null) parts.push(`sa="${spacing.spaceAbovePt}"`);
  if (spacing.spaceBelowPt != null) parts.push(`sb="${spacing.spaceBelowPt}"`);
  if (spacing.lineSpacing != null) parts.push(`ls="${spacing.lineSpacing}"`);
  return parts.length > 0 ? ` <!--gdocs-spacing ${parts.join(" ")}-->` : "";
}

function readParagraphSpacing(paragraph: any): ParagraphSpacing {
  const ps = paragraph.paragraphStyle ?? {};
  const spacing: ParagraphSpacing = {};
  if (ps.spaceAbove?.magnitude != null) spacing.spaceAbovePt = ps.spaceAbove.magnitude;
  if (ps.spaceBelow?.magnitude != null) spacing.spaceBelowPt = ps.spaceBelow.magnitude;
  if (ps.lineSpacing != null) spacing.lineSpacing = ps.lineSpacing;
  return spacing;
}

// So exporta no Markdown o que importa pra fidelidade (ignora sb=0 pra nao "travar" lista grudada)
function spacingForMarkdownExport(spacing: ParagraphSpacing): ParagraphSpacing | null {
  const out: ParagraphSpacing = {};
  if (spacing.spaceAbovePt != null && spacing.spaceAbovePt > 0) out.spaceAbovePt = spacing.spaceAbovePt;
  if (spacing.spaceBelowPt != null && spacing.spaceBelowPt > 0) out.spaceBelowPt = spacing.spaceBelowPt;
  if (spacing.lineSpacing != null) out.lineSpacing = spacing.lineSpacing;
  return out.spaceAbovePt != null || out.spaceBelowPt != null || out.lineSpacing != null ? out : null;
}

function pushParagraphSpacingRequest(
  paragraphStyleRequests: unknown[],
  startIndex: number,
  endIndex: number,
  spacing: ParagraphSpacing
): void {
  const paragraphStyle: Record<string, unknown> = {};
  const fields: string[] = [];
  if (spacing.spaceAbovePt != null) {
    paragraphStyle.spaceAbove = { magnitude: spacing.spaceAbovePt, unit: "PT" };
    fields.push("spaceAbove");
  }
  if (spacing.spaceBelowPt != null) {
    paragraphStyle.spaceBelow = { magnitude: spacing.spaceBelowPt, unit: "PT" };
    fields.push("spaceBelow");
  }
  if (spacing.lineSpacing != null) {
    paragraphStyle.lineSpacing = spacing.lineSpacing;
    fields.push("lineSpacing");
  }
  if (fields.length === 0) return;
  paragraphStyleRequests.push({
    updateParagraphStyle: {
      range: { startIndex, endIndex },
      paragraphStyle,
      fields: fields.join(","),
    },
  });
}

function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// "Impressao digital" curta do conteudo, pra saber se a nota mudou desde a ultima sincronizacao
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

type DiffLine = { type: "same" | "removed" | "added"; text: string };

// Diff classico por LCS (mesma familia de algoritmo que o git usa): compara linha por linha
function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "removed", text: a[i] });
      i++;
    } else {
      result.push({ type: "added", text: b[j] });
      j++;
    }
  }

  while (i < n) {
    result.push({ type: "removed", text: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: "added", text: b[j] });
    j++;
  }

  return result;
}

type MergeHunk = { kind: "same"; lines: string[] } | { kind: "change"; localLines: string[]; remoteLines: string[] };

// Agrupa o diff em trechos: "igual" (contexto) e "mudanca" (onde local e remoto divergem)
function groupIntoHunks(diff: DiffLine[]): MergeHunk[] {
  const hunks: MergeHunk[] = [];
  let i = 0;

  while (i < diff.length) {
    if (diff[i].type === "same") {
      const lines: string[] = [];
      while (i < diff.length && diff[i].type === "same") {
        lines.push(diff[i].text);
        i++;
      }
      hunks.push({ kind: "same", lines });
      continue;
    }

    const localLines: string[] = [];
    const remoteLines: string[] = [];
    while (i < diff.length && diff[i].type !== "same") {
      if (diff[i].type === "removed") {
        localLines.push(diff[i].text);
      } else {
        remoteLines.push(diff[i].text);
      }
      i++;
    }
    hunks.push({ kind: "change", localLines, remoteLines });
  }

  return hunks;
}

// Le uma linha de Markdown e quebra em pedacos com o estilo de cada um (negrito, italico, codigo, link)
function parseInlineSpans(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    const rest = line.slice(i);
    let m: RegExpExecArray | null;

    // <span style="...">...</span>: color, font-family, font-size (pt)
    if ((m = /^<span style="([^"]*)">([\s\S]*?)<\/span>/.exec(rest))) {
      const css = parseCssStyleAttr(m[1]);
      const innerTokens = parseInlineSpans(m[2]);
      for (const inner of innerTokens) {
        tokens.push({
          ...inner,
          color: css.color ?? inner.color,
          highlight: css.highlight ?? inner.highlight,
          fontFamily: css.fontFamily ?? inner.fontFamily,
          fontSizePt: css.fontSizePt ?? inner.fontSizePt,
        });
      }
      i += m[0].length;
      continue;
    }

    // Wiki/MD image FIRST — senao "_" em !_gdocs_media/... vira italico e corrompe o path
    if ((m = /^!\[\[([^\]]+)\]\]/.exec(rest))) {
      tokens.push({ text: `![[${m[1]}]]` }); // placeholder; lines with images sao tipicamente bloco "image"
      i += m[0].length;
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(rest))) {
      tokens.push({ text: m[0] });
      i += m[0].length;
      continue;
    }

    if ((m = /^`([^`]+)`/.exec(rest))) {
      tokens.push({ text: m[1], code: true });
      i += m[0].length;
      continue;
    }

    if ((m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rest))) {
      tokens.push({ text: m[1], link: m[2] });
      i += m[0].length;
      continue;
    }

    if ((m = /^(?:\*\*\*([^*]+)\*\*\*|___([^_]+)___)/.exec(rest))) {
      tokens.push({ text: (m[1] ?? m[2]) as string, bold: true, italic: true });
      i += m[0].length;
      continue;
    }

    if ((m = /^(?:\*\*([^*]+)\*\*|__([^_]+)__)/.exec(rest))) {
      tokens.push({ text: (m[1] ?? m[2]) as string, bold: true });
      i += m[0].length;
      continue;
    }

    if ((m = /^(?:\*([^*]+)\*|_([^_]+)_)/.exec(rest))) {
      tokens.push({ text: (m[1] ?? m[2]) as string, italic: true });
      i += m[0].length;
      continue;
    }

    const nextSpecial = rest.slice(1).search(/[`\[*_<]/);
    const takeLen = nextSpecial === -1 ? rest.length : nextSpecial + 1;
    tokens.push({ text: rest.slice(0, takeLen) });
    i += takeLen;
  }

  return tokens;
}

// Detecta numeracao manual no texto ("1. item" ou "<span...>1. item</span>") e remove o prefixo.
// Necessario porque Sync corrompido / TOC colado vira "- 1. item", e o Publish sem isso gera "• 1. item".
function stripLeadingManualNumber(content: string): { ordered: boolean; content: string } {
  const spanWrap = /^<span style="([^"]*)">([\s\S]*?)<\/span>\s*$/.exec(content);
  if (spanWrap) {
    const numbered = /^(\d+)\.\s+([\s\S]*)$/.exec(spanWrap[2]);
    if (numbered) {
      return { ordered: true, content: `<span style="${spanWrap[1]}">${numbered[2]}</span>` };
    }
    return { ordered: false, content };
  }

  const plain = /^(\d+)\.\s+(.*)$/.exec(content);
  if (plain) {
    return { ordered: true, content: plain[2] };
  }

  return { ordered: false, content };
}

function isMarkdownTableSeparator(line: string): boolean {
  const t = line.trim();
  return /^\|?[\s\-:|]+\|?$/.test(t) && t.includes("-");
}

function splitMarkdownTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((cell) => cell.trim().replace(/<br\s*\/?>/gi, "\n"));
}

function parseMarkdownTableLines(lines: string[]): TableCellData[][] {
  const rows: TableCellData[][] = [];
  for (const line of lines) {
    if (isMarkdownTableSeparator(line)) continue;
    const cells = splitMarkdownTableRow(line).map((text) => ({ text }));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function parseHtmlTable(html: string): TableCellData[][] | null {
  const rows: TableCellData[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html))) {
    const cells: TableCellData[] = [];
    const cellRe = /<t[hd]\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] ?? "";
      const styleAttr = /style="([^"]*)"/i.exec(attrs)?.[1] ?? "";
      const bg = /background-color:\s*(#[0-9a-fA-F]{6})/i.exec(styleAttr)?.[1]?.toLowerCase();
      const borderMatch = /border:\s*([\d.]+)pt\s+solid\s+(#[0-9a-fA-F]{6})/i.exec(styleAttr);
      let text = cellMatch[2]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<strong><em>([\s\S]*?)<\/em><\/strong>/gi, "***$1***")
        .replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**")
        .replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*")
        .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
        .trim();
      cells.push({
        text,
        backgroundColor: bg,
        borderColor: borderMatch?.[2]?.toLowerCase(),
        borderWidthPt: borderMatch ? parseFloat(borderMatch[1]) : undefined,
      });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows.length > 0 ? rows : null;
}

function cellMarkdownToInlineTokens(cellMd: string): InlineToken[] {
  const normalized = cellMd.replace(/<br\s*\/?>/gi, "\n");
  const lines = normalized.split("\n");
  const tokens: InlineToken[] = [];
  for (let i = 0; i < lines.length; i++) {
    tokens.push(...parseInlineSpans(lines[i]));
    if (i < lines.length - 1) tokens.push({ text: "\n" });
  }
  return tokens;
}

function inlineTokensToPlain(tokens: InlineToken[]): string {
  return tokens.map((t) => t.text).join("");
}

function buildTextStyleRequestsForTokens(
  tokens: InlineToken[],
  startIndex: number,
  forceMonospace = false
): unknown[] {
  const requests: unknown[] = [];
  let cursor = startIndex;
  for (const token of tokens) {
    const spanStart = cursor;
    cursor += token.text.length;
    if (token.text.length === 0 || token.text === "\n") continue;

    const fields: string[] = [];
    const textStyle: Record<string, unknown> = {};

    if (token.bold) {
      fields.push("bold");
      textStyle.bold = true;
    }
    if (token.italic) {
      fields.push("italic");
      textStyle.italic = true;
    }
    if (forceMonospace || token.code) {
      fields.push("weightedFontFamily");
      textStyle.weightedFontFamily = { fontFamily: MONOSPACE_FONT_FAMILY };
    } else if (token.fontFamily) {
      fields.push("weightedFontFamily");
      textStyle.weightedFontFamily = { fontFamily: token.fontFamily };
    }
    if (token.fontSizePt != null) {
      fields.push("fontSize");
      textStyle.fontSize = { magnitude: token.fontSizePt, unit: "PT" };
    }
    if (token.link) {
      fields.push("link");
      textStyle.link = { url: token.link };
    }
    if (token.color) {
      fields.push("foregroundColor");
      textStyle.foregroundColor = { color: { rgbColor: hexToRgbColor(token.color) } };
    }
    if (token.highlight) {
      fields.push("backgroundColor");
      textStyle.backgroundColor = { color: { rgbColor: hexToRgbColor(token.highlight) } };
    }

    if (fields.length > 0) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: spanStart, endIndex: cursor },
          textStyle,
          fields: fields.join(","),
        },
      });
    }
  }
  return requests;
}

// GFM simples (sem cor). Preferido quando o Doc nao pinta celulas.
function formatGfmTable(rows: TableCellData[][]): string {
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const normalize = (row: TableCellData[]) => {
    const cells = row.map((c) => c.text.replace(/\n/g, "<br>").replace(/\|/g, "\\|"));
    while (cells.length < colCount) cells.push("");
    return `| ${cells.join(" | ")} |`;
  };
  const lines = [normalize(rows[0]), `| ${Array(colCount).fill("---").join(" | ")} |`];
  for (const row of rows.slice(1)) lines.push(normalize(row));
  return lines.join("\n");
}

function formatTableMarkdown(rows: TableCellData[][]): string {
  const needsHtml = rows.some((r) =>
    r.some(
      (c) =>
        Boolean(c.backgroundColor) ||
        Boolean(c.borderColor) ||
        /<\/?[a-z]|(\*\*|__)/i.test(c.text)
    )
  );
  return needsHtml ? formatHtmlTable(rows) : formatGfmTable(rows);
}

/** Markdown inline → HTML pra celulas <td> (Obsidian nao renderiza ** dentro de HTML table). */
function cellMarkdownToHtml(md: string): string {
  let s = md.replace(/\n/g, "<br>");
  // Nao mexe em spans HTML ja existentes; converte so markdown restante
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

// HTML com background/borda das celulas — Markdown GFM nao aguenta estilo do Docs
function formatHtmlTable(rows: TableCellData[][]): string {
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const normalized = rows.map((r) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push({ text: "" });
    return padded;
  });

  const firstRowIsHeader = normalized[0].some((c) => Boolean(c.backgroundColor));

  const renderCell = (cell: TableCellData, tag: "th" | "td") => {
    const styles: string[] = [];
    if (cell.backgroundColor) styles.push(`background-color:${cell.backgroundColor}`);
    if (cell.borderColor && (cell.borderWidthPt ?? 0) > 0) {
      styles.push(`border:${cell.borderWidthPt}pt solid ${cell.borderColor}`);
    }
    if (tag === "th" && cell.backgroundColor) {
      styles.push("color:#ffffff", "font-weight:bold");
    }
    const styleAttr = styles.length > 0 ? ` style="${styles.join(";")}"` : "";
    const content = cellMarkdownToHtml(cell.text);
    return `<${tag}${styleAttr}>${content}</${tag}>`;
  };

  const lines: string[] = ["<table>"];
  if (firstRowIsHeader) {
    lines.push("<thead>");
    lines.push(`<tr>${normalized[0].map((c) => renderCell(c, "th")).join("")}</tr>`);
    lines.push("</thead>");
    lines.push("<tbody>");
    for (const row of normalized.slice(1)) {
      lines.push(`<tr>${row.map((c) => renderCell(c, "td")).join("")}</tr>`);
    }
    lines.push("</tbody>");
  } else {
    lines.push("<tbody>");
    for (const row of normalized) {
      lines.push(`<tr>${row.map((c) => renderCell(c, "td")).join("")}</tr>`);
    }
    lines.push("</tbody>");
  }
  lines.push("</table>");
  return lines.join("\n");
}

function formatCalloutMarkdown(title: string, body: string): string {
  const bodyLines = body.split("\n").map((l) => `> ${l}`);
  return [`> [!tip] ${title}`, ...bodyLines].join("\n");
}

/** Normaliza caminho de imagem (wiki alias, corrupcao *_*, pastas antigas). */
function normalizeImagePath(raw: string): string {
  let path = raw.trim().split("|")[0].trim();
  path = path.replace(/^\*gdocs\*media\//i, `${GDOCS_MEDIA_FOLDER}/`);
  path = path.replace(new RegExp(`^${GDOCS_MEDIA_FOLDER_LEGACY}/`, "i"), `${GDOCS_MEDIA_FOLDER}/`);
  return path.replace(/^\/+/, "");
}

function extractImagePathFromMarkdown(fragment: string): string | null {
  const wiki = /^!\[\[([^\]]+)\]\]\s*$/.exec(fragment.trim());
  if (wiki) return normalizeImagePath(wiki[1]);
  const md = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(fragment.trim());
  if (md) return normalizeImagePath(md[2]);
  return null;
}

/**
 * Quebra uma linha que mistura texto e ![[img]] em blocos separados.
 * Ex.: "caption ![[a.png]]" → paragraph + image
 */
function pushLineWithPossibleImages(
  blocks: MarkdownBlock[],
  line: string,
  spacing?: ParagraphSpacing
): void {
  const re = /(!\[[^\]]*\]\([^)]+\)|!\[\[[^\]]+\]\])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let found = false;

  while ((match = re.exec(line))) {
    found = true;
    const before = line.slice(last, match.index).trim();
    if (before.length > 0) {
      blocks.push({ type: "paragraph", tokens: parseInlineSpans(before), spacing });
    }
    const path = extractImagePathFromMarkdown(match[0]);
    if (path) blocks.push({ type: "image", path });
    last = match.index + match[0].length;
  }

  if (!found) {
    blocks.push({ type: "paragraph", tokens: parseInlineSpans(line), spacing });
    return;
  }

  const after = line.slice(last).trim();
  if (after.length > 0) {
    blocks.push({ type: "paragraph", tokens: parseInlineSpans(after), spacing });
  }
}

// Quebra o Markdown inteiro em blocos: titulo, lista, paragrafo, bloco de codigo, linha em branco
function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const { line, spacing } = parseSpacingComment(rawLine);

    const fenceOpenMatch = /^```(\S*)/.exec(line.trim());
    if (fenceOpenMatch) {
      const language = fenceOpenMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // pula a cerca de fechamento
      blocks.push({ type: "code", text: codeLines.join("\n"), language });
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        tokens: parseInlineSpans(headingMatch[2]),
        spacing,
      });
      i++;
      continue;
    }

    // Linha horizontal markdown → no Doc vira borderBottom do titulo anterior (a "linha embaixo do Sumario")
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Callout Obsidian: > [!tip] titulo
    const calloutMatch = /^>\s*\[!(\w+)\]\s*(.*)$/.exec(line.trim());
    if (calloutMatch) {
      const title = calloutMatch[2].trim();
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (!/^>/.test(next)) break;
        bodyLines.push(next.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "callout", title: title || calloutMatch[1], body: bodyLines.join("\n") });
      continue;
    }

    // Tabela HTML (com cores de celula do Docs)
    if (/<table\b/i.test(line)) {
      let html = "";
      while (i < lines.length) {
        html += lines[i] + "\n";
        i++;
        if (/<\/table>/i.test(html)) break;
      }
      const rows = parseHtmlTable(html);
      if (rows) blocks.push({ type: "table", rows });
      continue;
    }

    // Tabela GFM: | col | col |
    if (/^\|/.test(line.trim())) {
      const tableLines: string[] = [];
      while (i < lines.length) {
        const { line: tableLine } = parseSpacingComment(lines[i]);
        if (!/^\|/.test(tableLine.trim())) break;
        tableLines.push(tableLine);
        i++;
      }
      const rows = parseMarkdownTableLines(tableLines);
      if (rows.length > 0) {
        blocks.push({ type: "table", rows });
      }
      continue;
    }

    const checkboxMatch = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (checkboxMatch) {
      blocks.push({
        type: "checkbox",
        checked: checkboxMatch[1].toLowerCase() === "x",
        tokens: parseInlineSpans(checkboxMatch[2]),
        spacing,
      });
      i++;
      continue;
    }

    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      // "- 1. item" / "* 1. item" → lista numerada de verdade, sem o "1." no texto
      const stripped = stripLeadingManualNumber(bulletMatch[1]);
      blocks.push({
        type: stripped.ordered ? "numbered" : "bullet",
        tokens: parseInlineSpans(stripped.content),
        spacing,
      });
      i++;
      continue;
    }

    const numberedMatch = /^\d+\.\s+(.*)$/.exec(line);
    if (numberedMatch) {
      // Se o texto ainda trouxer "1. " por corrupcao anterior, remove de novo
      const stripped = stripLeadingManualNumber(numberedMatch[1]);
      blocks.push({ type: "numbered", tokens: parseInlineSpans(stripped.content), spacing });
      i++;
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // Imagem sozinha na linha OU texto + imagem na mesma linha
    const onlyImage = extractImagePathFromMarkdown(line);
    if (onlyImage) {
      blocks.push({ type: "image", path: onlyImage });
      i++;
      continue;
    }
    if (/!\[[^\]]*\]\([^)]+\)|!\[\[[^\]]+\]\]/.test(line)) {
      pushLineWithPossibleImages(blocks, line, spacing);
      i++;
      continue;
    }

    blocks.push({ type: "paragraph", tokens: parseInlineSpans(line), spacing });
    i++;
  }

  return blocks;
}

// Converte blocos (sem tabelas) em texto + 3 grupos de requests.
// Tabelas sao publicadas a parte em publishNoteToDoc (insertTable + fill).
function buildDocRequestsFromBlocks(
  blocks: MarkdownBlock[],
  startCursor = 1
): {
  text: string;
  paragraphStyleRequests: unknown[];
  spacingRequests: unknown[];
  textStyleRequests: unknown[];
} {
  let text = "";
  let cursor = startCursor;

  const paragraphStyleRequests: unknown[] = [];
  const spacingRequests: unknown[] = [];
  const textStyleRequests: unknown[] = [];

  let bulletRunStart: number | null = null;
  let bulletRunKind: ListKind | null = null;
  let lastHeading: { start: number; end: number; color: string | null } | null = null;

  const flushBulletRun = (endIndex: number) => {
    if (bulletRunStart === null || bulletRunKind === null) return;
    // endIndex precisa cair no fim do ultimo item (depois do "\n" dele). Se passar para o
    // paragrafo vazio seguinte, o Google cria bullets vazios no fim da lista.
    if (endIndex > bulletRunStart) {
      const bulletPreset =
        bulletRunKind === "ordered"
          ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : bulletRunKind === "checkbox"
            ? "BULLET_CHECKBOX"
            : "BULLET_DISC_CIRCLE_SQUARE";
      paragraphStyleRequests.push({
        createParagraphBullets: {
          range: { startIndex: bulletRunStart, endIndex },
          bulletPreset,
        },
      });
    }
    bulletRunStart = null;
    bulletRunKind = null;
  };

  for (const block of blocks) {
    // table/callout/image: publicados a parte em publishNoteToDoc
    if (block.type === "table" || block.type === "callout" || block.type === "image") continue;

    const isListItem = block.type === "bullet" || block.type === "numbered" || block.type === "checkbox";
    const listKind: ListKind | null =
      block.type === "numbered" ? "ordered" : block.type === "checkbox" ? "checkbox" : block.type === "bullet" ? "bullet" : null;

    if (bulletRunStart !== null && (!isListItem || listKind !== bulletRunKind)) {
      flushBulletRun(cursor);
    }

    if (block.type === "hr") {
      // Nao insere "---" como texto: aplica a linha embaixo do titulo anterior
      if (lastHeading) {
        const lineColor = lastHeading.color ?? "#000000";
        paragraphStyleRequests.push({
          updateParagraphStyle: {
            range: { startIndex: lastHeading.start, endIndex: lastHeading.end },
            paragraphStyle: {
              borderBottom: {
                width: { magnitude: 1, unit: "PT" },
                padding: { magnitude: 3, unit: "PT" },
                dashStyle: "SOLID",
                color: { color: { rgbColor: hexToRgbColor(lineColor) } },
              },
            },
            fields: "borderBottom",
          },
        });
      }
      continue;
    }

    if (block.type === "blank") {
      text += "\n";
      cursor += 1;
      continue;
    }

    if (block.type === "code") {
      const blockStart = cursor;
      text += block.text;
      cursor += block.text.length;
      if (block.text.length > 0) {
        textStyleRequests.push({
          updateTextStyle: {
            range: { startIndex: blockStart, endIndex: cursor },
            textStyle: { weightedFontFamily: { fontFamily: MONOSPACE_FONT_FAMILY } },
            fields: "weightedFontFamily",
          },
        });

        // Guarda a linguagem (ex: dataviewjs) de forma invisivel no Doc, pra o Sync now conseguir recuperar depois
        if (block.language) {
          paragraphStyleRequests.push({
            createNamedRange: {
              name: `${CODE_LANGUAGE_NAMED_RANGE_PREFIX}${block.language}`,
              range: { startIndex: blockStart, endIndex: cursor },
            },
          });
        }
      }
      text += "\n";
      cursor += 1;
      continue;
    }

    const paragraphStart = cursor;

    for (const token of block.tokens) {
      const spanStart = cursor;
      text += token.text;
      cursor += token.text.length;

      const fields: string[] = [];
      const textStyle: Record<string, unknown> = {};

      if (token.bold) {
        fields.push("bold");
        textStyle.bold = true;
      }
      if (token.italic) {
        fields.push("italic");
        textStyle.italic = true;
      }
      if (token.code) {
        fields.push("weightedFontFamily");
        textStyle.weightedFontFamily = { fontFamily: MONOSPACE_FONT_FAMILY };
      } else if (token.fontFamily) {
        fields.push("weightedFontFamily");
        textStyle.weightedFontFamily = { fontFamily: token.fontFamily };
      }
      if (token.fontSizePt != null) {
        fields.push("fontSize");
        textStyle.fontSize = { magnitude: token.fontSizePt, unit: "PT" };
      }
      if (token.link) {
        fields.push("link");
        textStyle.link = { url: token.link };
      }
      if (token.color) {
        fields.push("foregroundColor");
        textStyle.foregroundColor = { color: { rgbColor: hexToRgbColor(token.color) } };
      }
      if (token.highlight) {
        fields.push("backgroundColor");
        textStyle.backgroundColor = { color: { rgbColor: hexToRgbColor(token.highlight) } };
      }

      if (fields.length > 0 && token.text.length > 0) {
        textStyleRequests.push({
          updateTextStyle: {
            range: { startIndex: spanStart, endIndex: cursor },
            textStyle,
            fields: fields.join(","),
          },
        });
      }
    }

    text += "\n";
    cursor += 1;

    if (block.type === "heading") {
      paragraphStyleRequests.push({
        updateParagraphStyle: {
          range: { startIndex: paragraphStart, endIndex: cursor },
          paragraphStyle: { namedStyleType: HEADING_NAMED_STYLES[block.level - 1] },
          fields: "namedStyleType",
        },
      });
      lastHeading = {
        start: paragraphStart,
        end: cursor,
        color: block.tokens.find((t) => t.color)?.color ?? null,
      };
    }

    // Espacamento vai pra lista SEPARADA: createParagraphBullets no final de
    // paragraphStyleRequests apaga spaceBelow se o espacamento vier antes dele.
    const blockSpacing = "spacing" in block ? block.spacing : undefined;
    const spacing: ParagraphSpacing = isListItem
      ? {
          spaceAbovePt: blockSpacing?.spaceAbovePt,
          spaceBelowPt: Math.max(
            blockSpacing?.spaceBelowPt ?? MIN_LIST_SPACE_BELOW_PT,
            MIN_LIST_SPACE_BELOW_PT
          ),
          lineSpacing: blockSpacing?.lineSpacing ?? DEFAULT_LIST_SPACING.lineSpacing,
        }
      : { ...blockSpacing };
    pushParagraphSpacingRequest(spacingRequests, paragraphStart, cursor, spacing);

    if (isListItem && bulletRunStart === null) {
      bulletRunStart = paragraphStart;
      bulletRunKind = listKind;
    }
  }

  flushBulletRun(cursor);

  return { text, paragraphStyleRequests, spacingRequests, textStyleRequests };
}

function buildDocRequestsFromMarkdown(markdown: string): {
  text: string;
  paragraphStyleRequests: unknown[];
  spacingRequests: unknown[];
  textStyleRequests: unknown[];
} {
  return buildDocRequestsFromBlocks(parseMarkdownBlocks(markdown), 1);
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createPkcePair() {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function runGoogleOAuthFlow(clientId: string, clientSecret: string): Promise<TokenSet> {
  const { verifier, challenge } = createPkcePair();
  const state = base64UrlEncode(randomBytes(16));
  let redirectUri = "";

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const returnedCode = requestUrl.searchParams.get("code");
      const returnedState = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");

      res.setHeader("Content-Type", "text/html; charset=utf-8");

      if (error) {
        res.end("<h1>Autorizacao cancelada.</h1><p>Pode fechar esta aba.</p>");
        server.close();
        reject(new Error(`Google retornou erro: ${error}`));
        return;
      }

      if (!returnedCode || returnedState !== state) {
        res.end("<h1>Requisicao invalida.</h1>");
        return;
      }

      res.end("<h1>Conta conectada com sucesso!</h1><p>Pode fechar esta aba e voltar ao Obsidian.</p>");
      server.close();
      resolve(returnedCode);
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      redirectUri = `http://127.0.0.1:${port}/callback`;

      const authUrl = new URL(GOOGLE_AUTH_URL);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", OAUTH_SCOPE);
      authUrl.searchParams.set("access_type", "offline");
      // Forca tela de consentimento + escopos novos (Drive) mesmo se ja conectou so Docs antes
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("include_granted_scopes", "true");
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      shell.openExternal(authUrl.toString());
    });

    window.setTimeout(() => {
      server.close();
      reject(new Error("Tempo esgotado esperando a autorizacao do Google."));
    }, OAUTH_TIMEOUT_MS);
  });

  const tokenResponse = await requestUrl({
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
    throw: false,
  });

  if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
    throw new Error(`Falha ao trocar o code por tokens (HTTP ${tokenResponse.status}).`);
  }

  const tokenData = tokenResponse.json as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!tokenData.refresh_token || !tokenData.access_token || tokenData.expires_in == null) {
    throw new Error(
      "Google nao retornou refresh_token. Revogue o acesso em myaccount.google.com/permissions e tente de novo."
    );
  }

  const scopes = await fetchAccessTokenScopes(tokenData.access_token, tokenData.scope);
  if (!tokenHasDriveScope(scopes)) {
    throw new Error(
      "Login OK no Docs, mas o Google NAO concedeu o escopo Drive. " +
        "No Google Cloud > Tela de consentimento OAuth, adicione " +
        "https://www.googleapis.com/auth/drive , ative a Drive API, " +
        "revogue o app em myaccount.google.com/permissions e conecte de novo."
    );
  }
  if (!tokenHasFullDriveScope(scopes)) {
    throw new Error(
      "Drive foi concedido so como drive.file (imagens). " +
        "Pra organizar Doc+imagens na pasta, adicione o escopo " +
        "https://www.googleapis.com/auth/drive na Tela de consentimento, " +
        "revogue o app e conecte de novo."
    );
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    grantedScopes: scopes.join(" "),
  };
}

async function fetchAccessTokenScopes(accessToken: string, fallbackScope?: string): Promise<string[]> {
  try {
    const info = await requestUrl({
      url: `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`,
      throw: false,
    });
    if (info.status >= 200 && info.status < 300) {
      const scope = (info.json as { scope?: string })?.scope ?? "";
      if (scope.trim()) return scope.split(/\s+/).filter(Boolean);
    }
  } catch (err) {
    console.error(err);
  }
  return (fallbackScope ?? "").split(/\s+/).filter(Boolean);
}

function tokenHasDriveScope(scopes: string[]): boolean {
  return scopes.some(
    (s) =>
      s === DRIVE_SCOPE ||
      s === DRIVE_SCOPE_FILE_ONLY ||
      s === "https://www.googleapis.com/auth/drive.appdata"
  );
}

/** Precisa do Drive completo pra mover Docs que o usuario ja tinha. */
function tokenHasFullDriveScope(scopes: string[]): boolean {
  return scopes.some((s) => s === DRIVE_SCOPE || s === "https://www.googleapis.com/auth/drive");
}

async function clearGoogleTokens(plugin: GoogleDocsHubPlugin): Promise<void> {
  delete plugin.settings.accessToken;
  delete plugin.settings.refreshToken;
  delete plugin.settings.accessTokenExpiresAt;
  delete plugin.settings.grantedScopes;
  await plugin.saveSettings();
}

async function ensureDriveScopeOrThrow(plugin: GoogleDocsHubPlugin): Promise<void> {
  const accessToken = await ensureFreshAccessToken(plugin);
  const cached = (plugin.settings.grantedScopes ?? "").split(/\s+/).filter(Boolean);
  if (tokenHasDriveScope(cached)) return;

  const scopes = await fetchAccessTokenScopes(accessToken, plugin.settings.grantedScopes);
  plugin.settings.grantedScopes = scopes.join(" ");
  await plugin.saveSettings();
  if (tokenHasDriveScope(scopes)) return;

  await clearGoogleTokens(plugin);
  throw new Error(
    "Sem permissao Drive neste login. Rode Connect Google account de novo e aceite acesso ao Drive. " +
      "Na Tela de consentimento OAuth do Google Cloud, use o escopo https://www.googleapis.com/auth/drive"
  );
}

async function ensureFullDriveScopeOrThrow(plugin: GoogleDocsHubPlugin): Promise<void> {
  await ensureDriveScopeOrThrow(plugin);
  const scopes = (plugin.settings.grantedScopes ?? "").split(/\s+/).filter(Boolean);
  if (tokenHasFullDriveScope(scopes)) return;

  const accessToken = await ensureFreshAccessToken(plugin);
  const fresh = await fetchAccessTokenScopes(accessToken, plugin.settings.grantedScopes);
  plugin.settings.grantedScopes = fresh.join(" ");
  await plugin.saveSettings();
  if (tokenHasFullDriveScope(fresh)) return;

  throw new Error(
    "Login tem so drive.file. Pra mover o Doc pra pasta do hub, adicione " +
      "https://www.googleapis.com/auth/drive na Tela de consentimento, revogue o app e Connect de novo."
  );
}

async function ensureFreshAccessToken(plugin: GoogleDocsHubPlugin): Promise<string> {
  const { accessToken, accessTokenExpiresAt, refreshToken, clientId, clientSecret } = plugin.settings;

  const stillValid =
    accessToken && accessTokenExpiresAt && Date.now() < accessTokenExpiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS;

  if (stillValid) {
    return accessToken as string;
  }

  if (!refreshToken) {
    throw new Error("Conta Google nao conectada. Rode o comando Connect Google account primeiro.");
  }

  const response = await requestUrl({
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Falha ao renovar o token de acesso (HTTP ${response.status}). Tente reconectar a conta.`);
  }

  const data = response.json as { access_token?: string; expires_in?: number };
  if (!data.access_token || data.expires_in == null) {
    throw new Error("Falha ao renovar o token de acesso: resposta invalida do Google.");
  }

  plugin.settings.accessToken = data.access_token;
  plugin.settings.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  await plugin.saveSettings();

  return plugin.settings.accessToken as string;
}

async function googleApiFetch(
  plugin: GoogleDocsHubPlugin,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<GoogleHttpResponse> {
  const accessToken = await ensureFreshAccessToken(plugin);
  const response = await requestUrl({
    url,
    method: options.method ?? "GET",
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
    body: options.body,
    throw: false,
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.json,
    text: async () => response.text,
  };
}

// includeTabsContent=true e obrigatorio pra API devolver o conteudo de TODAS as guias do Doc,
// nao so a primeira (esse e o comportamento padrao do Google se a gente nao pedir explicitamente)
async function fetchGoogleDoc(plugin: GoogleDocsHubPlugin, docId: string): Promise<any> {
  const response = await googleApiFetch(plugin, `${GOOGLE_DOCS_API_URL}/${docId}?includeTabsContent=true`);
  if (!response.ok) {
    const err = new Error(
      `Nao foi possivel ler o Doc (HTTP ${response.status}). Confira se o docId esta correto e se voce tem acesso a ele.`
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  return response.json();
}

/** Doc apagado, na lixeira ou sem acesso: HTTP 404/403. */
function isDocMissingError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 404 || status === 403) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP 404|HTTP 403/.test(msg);
}

async function clearNoteDocLink(plugin: GoogleDocsHubPlugin, file: TFile): Promise<void> {
  await plugin.app.fileManager.processFrontMatter(file, (fm) => {
    delete fm[FRONTMATTER_DOC_ID_KEY];
    delete fm[FRONTMATTER_DOC_URL_KEY];
    delete fm[FRONTMATTER_DOC_TAB_ID_KEY];
    delete fm[FRONTMATTER_LAST_SYNCED_REVISION_KEY];
    delete fm[FRONTMATTER_LAST_SYNCED_HASH_KEY];
  });
}

/** Oferece desvincular se o Doc sumiu. Retorna true se tratou (desvinculou ou usuario cancelou). */
async function offerUnlinkIfDocGone(
  plugin: GoogleDocsHubPlugin,
  file: TFile,
  err: unknown
): Promise<boolean> {
  if (!isDocMissingError(err)) return false;

  return new Promise((resolve) => {
    new UnlinkMissingDocModal(plugin.app, file.basename, async (doUnlink) => {
      if (doUnlink) {
        await clearNoteDocLink(plugin, file);
        plugin.refreshUi();
        new Notice("Nota desvinculada. O Doc não existe mais (apagado ou na lixeira).");
      }
      resolve(true);
    }).open();
  });
}

class UnlinkMissingDocModal extends Modal {
  private noteName: string;
  private onChoose: (unlink: boolean) => void;

  constructor(app: App, noteName: string, onChoose: (unlink: boolean) => void) {
    super(app);
    this.noteName = noteName;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName("Google Doc não encontrado").setHeading();
    contentEl.createEl("p", {
      text:
        `A nota "${this.noteName}" ainda aponta pra um Doc, mas o Google respondeu que ele ` +
        `não existe ou está inacessível (apagado / lixeira / sem permissão).`,
    });
    contentEl.createEl("p", {
      text: "Desvincular esta nota agora? (remove google_doc_id e afins do frontmatter)",
    });

    contentEl
      .createEl("button", {
        text: "Sim, desvincular",
        cls: "mod-cta gdocs-hub-block-button-spaced",
      })
      .addEventListener("click", () => {
        this.close();
        this.onChoose(true);
      });

    contentEl
      .createEl("button", {
        text: "Não, manter o vínculo",
        cls: "gdocs-hub-block-button",
      })
      .addEventListener("click", () => {
        this.close();
        this.onChoose(false);
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Confirmação do botão Desvincular na barra da nota. */
class ConfirmUnlinkModal extends Modal {
  private noteName: string;
  private onChoose: (ok: boolean) => void;

  constructor(app: App, noteName: string, onChoose: (ok: boolean) => void) {
    super(app);
    this.noteName = noteName;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName("Desvincular Google Doc").setHeading();
    contentEl.createEl("p", {
      text:
        `Remover o vínculo da nota "${this.noteName}"? O Doc no Google não será apagado. ` +
        `Só saem as propriedades google_doc_* desta nota.`,
    });

    contentEl
      .createEl("button", {
        text: "Sim, desvincular",
        cls: "mod-cta gdocs-hub-block-button-spaced",
      })
      .addEventListener("click", () => {
        this.close();
        this.onChoose(true);
      });

    contentEl
      .createEl("button", {
        text: "Cancelar",
        cls: "gdocs-hub-block-button",
      })
      .addEventListener("click", () => {
        this.close();
        this.onChoose(false);
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Achata a arvore de guias (uma guia pode ter sub-guias) numa lista simples, na ordem que aparecem
function flattenDocTabs(tabs: any[] | undefined, out: any[] = []): any[] {
  for (const tab of tabs ?? []) {
    out.push(tab);
    if (tab.childTabs?.length) flattenDocTabs(tab.childTabs, out);
  }
  return out;
}

// Lista so o id e o titulo de cada guia, pra mostrar num seletor
function listDocTabs(doc: any): Array<{ tabId: string; title: string }> {
  return flattenDocTabs(doc.tabs).map((tab) => ({
    tabId: tab.tabProperties?.tabId,
    title: tab.tabProperties?.title || "(sem titulo)",
  }));
}

// Devolve o "corpo" da guia certa (ou a primeira, se a nota ainda nao tem guia salva/documento sem guias),
// no mesmo formato { body, lists, namedRanges, inlineObjects } que o resto do codigo ja sabe ler
function resolveDocForTab(
  doc: any,
  tabId?: string
): { body: any; lists: any; namedRanges: any; inlineObjects: Record<string, any> } {
  const flatTabs = flattenDocTabs(doc.tabs);

  if (flatTabs.length === 0) {
    return {
      body: doc.body,
      lists: doc.lists,
      namedRanges: doc.namedRanges,
      inlineObjects: doc.inlineObjects ?? {},
    };
  }

  const target = (tabId && flatTabs.find((tab) => tab.tabProperties?.tabId === tabId)) || flatTabs[0];
  const documentTab = target.documentTab ?? {};
  return {
    body: documentTab.body,
    lists: documentTab.lists,
    namedRanges: documentTab.namedRanges,
    inlineObjects: documentTab.inlineObjects ?? {},
  };
}

// Carimba tabId em todo range/location dos requests, senao o Google aplica na primeira guia por padrao.
// Inclui tableStartLocation (updateTableCellStyle) — sem isso as cores da tabela somem na guia certa.
function withTabId(requests: unknown[], tabId?: string): unknown[] {
  if (!tabId) return requests;

  const stamp = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) stamp(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    // Range: { startIndex, endIndex }
    if (typeof obj.startIndex === "number" && typeof obj.endIndex === "number") {
      obj.tabId = tabId;
    }
    // Location: { index } (nao confundir com Dimension { magnitude, unit })
    if (
      typeof obj.index === "number" &&
      obj.magnitude === undefined &&
      obj.unit === undefined
    ) {
      obj.tabId = tabId;
    }
    for (const child of Object.values(obj)) stamp(child);
  };

  return requests.map((request) => {
    const clone = JSON.parse(JSON.stringify(request));
    stamp(clone);
    return clone;
  });
}

// Junta so o texto puro de um paragrafo, sem aplicar nenhum estilo Markdown
function getParagraphPlainText(paragraph: any): string {
  const elements = paragraph.elements ?? [];
  let text = "";

  for (const element of elements) {
    const run = element.textRun;
    if (!run) continue;
    text += (run.content ?? "").replace(/\n$/, "");
  }

  return text;
}

// Verdadeiro se TODO o texto do paragrafo estiver em fonte monoespacada (nosso sinal de "isso e uma linha de codigo")
function isWholeLineMonospace(paragraph: any): boolean {
  const elements = paragraph.elements ?? [];
  let sawContent = false;

  for (const element of elements) {
    const run = element.textRun;
    if (!run) continue;
    const content = (run.content ?? "").replace(/\n$/, "");
    if (content.length === 0) continue;
    sawContent = true;
    if (run.textStyle?.weightedFontFamily?.fontFamily !== MONOSPACE_FONT_FAMILY) return false;
  }

  return sawContent;
}

function getParagraphBorderBottomColor(paragraph: any): string | null {
  const border = paragraph.paragraphStyle?.borderBottom;
  const width = border?.width?.magnitude ?? 0;
  if (width <= 0) return null;
  const rgb = border?.color?.color?.rgbColor;
  return rgb ? rgbColorToHex(rgb) : "#000000";
}

// Reconstroi a linha em Markdown, aplicando negrito/italico/fonte/tamanho/cor/link por trecho (textRun).
// Inline images ja baixadas entram como ![](caminho) — markdown puro NAO cria aresta no grafo
// (estrela fica no gdocs-media_Mapa via [[img]]; ![[wiki]] geraria floco de neve).
function renderParagraphMarkdown(
  paragraph: any,
  imagePaths?: Map<string, string>
): string {
  const elements = paragraph.elements ?? [];
  let markdown = "";

  for (const element of elements) {
    const inlineObjectId = element.inlineObjectElement?.inlineObjectId as string | undefined;
    if (inlineObjectId) {
      const vaultPath = imagePaths?.get(inlineObjectId);
      if (vaultPath) {
        if (markdown.length > 0 && !markdown.endsWith("\n")) markdown += "\n\n";
        markdown += `![](${vaultPath})`;
        if (!markdown.endsWith("\n")) markdown += "\n";
      }
      continue;
    }

    const run = element.textRun;
    if (!run) continue;

    const content = (run.content ?? "").replace(/\n$/, "");
    if (content.length === 0) continue;

    const style = run.textStyle ?? {};
    const fontFamily: string | undefined = style.weightedFontFamily?.fontFamily;
    const isMonospace = fontFamily === MONOSPACE_FONT_FAMILY;
    const fontSizePt: number | undefined =
      style.fontSize?.unit === "PT" && typeof style.fontSize?.magnitude === "number"
        ? style.fontSize.magnitude
        : undefined;

    let piece = content;

    if (isMonospace) {
      piece = `\`${piece}\``;
    } else if (style.bold && style.italic) {
      piece = `***${piece}***`;
    } else if (style.bold) {
      piece = `**${piece}**`;
    } else if (style.italic) {
      piece = `*${piece}*`;
    }

    if (style.link?.url) {
      piece = `[${piece}](${style.link.url})`;
    }

    const rgbColor = style.foregroundColor?.color?.rgbColor;
    const color = rgbColor ? rgbColorToHex(rgbColor) : undefined;
    const highlightRgb = style.backgroundColor?.color?.rgbColor;
    const highlight = highlightRgb ? rgbColorToHex(highlightRgb) : undefined;
    // Preserva Calibri/tamanho/marca-texto do Doc no Markdown
    piece = wrapWithStyleSpan(piece, {
      color,
      highlight,
      fontFamily: !isMonospace && fontFamily ? fontFamily : undefined,
      fontSizePt,
    });

    markdown += piece;
  }

  return markdown.trimEnd();
}

function paragraphHasInlineImage(paragraph: any): boolean {
  return (paragraph.elements ?? []).some((el: any) => el.inlineObjectElement?.inlineObjectId);
}

function collectInlineObjectIds(bodyContent: any[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const element of bodyContent) {
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    for (const pe of paragraph.elements ?? []) {
      const id = pe.inlineObjectElement?.inlineObjectId as string | undefined;
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function extensionFromContentType(contentType: string | undefined): string {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (ct === "image/jpeg" || ct === "image/jpg") return "jpg";
  if (ct === "image/gif") return "gif";
  if (ct === "image/webp") return "webp";
  if (ct === "image/svg+xml") return "svg";
  return "png";
}

function sanitizeMediaFileName(objectId: string): string {
  return objectId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function ensureVaultFolder(plugin: GoogleDocsHubPlugin, folderPath: string): Promise<void> {
  const parts = folderPath.replace(/\/+$/, "").split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

// Baixa imagens embutidas do Doc (contentUri temporario do Google) pra pasta do vault.
async function downloadDocImagesToVault(
  plugin: GoogleDocsHubPlugin,
  inlineObjects: Record<string, any>,
  objectIds: string[],
  folderPath: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (objectIds.length === 0) return result;

  const normalizedFolder = folderPath.replace(/\/+$/, "");
  if (normalizedFolder) {
    await ensureVaultFolder(plugin, normalizedFolder);
  }

  for (const objectId of objectIds) {
    const emb = inlineObjects[objectId]?.inlineObjectProperties?.embeddedObject;
    const contentUri: string | undefined =
      emb?.imageProperties?.contentUri || emb?.imageProperties?.sourceUri;
    if (!contentUri) continue;

    try {
      const response = await requestUrl({ url: contentUri, method: "GET", throw: false });
      if (response.status < 200 || response.status >= 300) {
        console.error(`Falha ao baixar imagem ${objectId}: HTTP ${response.status}`);
        continue;
      }

      const ext = extensionFromContentType(
        response.headers?.["content-type"] ?? response.headers?.["Content-Type"]
      );
      const fileName = `${sanitizeMediaFileName(objectId)}.${ext}`;
      const vaultPath = normalizedFolder ? `${normalizedFolder}/${fileName}` : fileName;
      const data = response.arrayBuffer;

      const existing = plugin.app.vault.getAbstractFileByPath(vaultPath);
      if (existing instanceof TFile) {
        await plugin.app.vault.modifyBinary(existing, data);
      } else {
        await plugin.app.vault.createBinary(vaultPath, data);
      }
      result.set(objectId, vaultPath);
    } catch (err) {
      console.error(`Falha ao baixar imagem ${objectId}:`, err);
    }
  }

  return result;
}

// Classifica lista do Google Docs:
// - checkbox: glyphType UNSPECIFIED sem glyphSymbol (lista de tarefas)
// - ordered: DECIMAL/ALPHA/ROMAN... ou glyphFormat tipo "%0."
// - bullet: tem glyphSymbol (●, ○...) — NAO usar /%\d/ solto no glyphFormat (bullets tambem tem "%0")
const ORDERED_GLYPH_TYPES = new Set([
  "DECIMAL",
  "ZERO_DECIMAL",
  "UPPER_ALPHA",
  "ALPHA",
  "UPPER_ROMAN",
  "ROMAN",
]);

function classifyListKind(doc: any, listId: string, nestingLevel: number): DocListKind {
  const level = doc.lists?.[listId]?.listProperties?.nestingLevels?.[nestingLevel];
  if (!level) return "bullet";

  // Marcador visual (bolinha etc.) = lista nao numerada
  if (typeof level.glyphSymbol === "string" && level.glyphSymbol.length > 0) {
    return "bullet";
  }

  if (ORDERED_GLYPH_TYPES.has(level.glyphType)) {
    return "ordered";
  }

  // Checklist do Google Docs: GLYPH_TYPE_UNSPECIFIED + sem glyphSymbol
  if (level.glyphType === "GLYPH_TYPE_UNSPECIFIED") {
    return "checkbox";
  }

  // So trata como numerada se o formato parecer "1." / "1)" — "%0" sozinho NAO basta
  if (typeof level.glyphFormat === "string" && /%\d[.)]/.test(level.glyphFormat)) {
    return "ordered";
  }

  return "bullet";
}

type DocToken =
  | { kind: "code"; text: string; startIndex?: number; language?: string }
  | { kind: "empty" }
  | { kind: "bullet"; listKind: DocListKind; text: string; spacing?: ParagraphSpacing }
  | { kind: "heading"; level: number; text: string; borderBottomColor?: string; spacing?: ParagraphSpacing }
  | { kind: "paragraph"; text: string; spacing?: ParagraphSpacing }
  | { kind: "table"; rows: TableCellData[][] }
  | { kind: "callout"; title: string; body: string };

function getTableCellPlainText(cell: any): string {
  const lines: string[] = [];
  for (const el of cell.content ?? []) {
    if (!el.paragraph) continue;
    lines.push(getParagraphPlainText(el.paragraph));
  }
  return lines.join("\n");
}

function getTableCellMarkdown(cell: any): string {
  const parts: string[] = [];
  for (const el of cell.content ?? []) {
    if (!el.paragraph) continue;
    const md = renderParagraphMarkdown(el.paragraph);
    if (md.length > 0) parts.push(md);
  }
  return parts.join("<br>");
}

function getTableCellBackgroundHex(cell: any): string | undefined {
  const rgb = cell.tableCellStyle?.backgroundColor?.color?.rgbColor;
  if (!rgb) return undefined;
  // Ignora branco/quase branco (fundo padrao)
  const r = rgb.red ?? 0;
  const g = rgb.green ?? 0;
  const b = rgb.blue ?? 0;
  if (r > 0.97 && g > 0.97 && b > 0.97) return undefined;
  return rgbColorToHex(rgb);
}

/** Pega a borda mais “forte” da celula (grossa ou colorida — nao a fina padrao ~0.5pt preta). */
function getTableCellAccentBorder(
  cell: any
): { color: string; widthPt: number } | undefined {
  const style = cell.tableCellStyle ?? {};
  const sides = [style.borderTop, style.borderBottom, style.borderLeft, style.borderRight];
  let best: { color: string; widthPt: number } | undefined;
  for (const border of sides) {
    if (!border) continue;
    const widthPt = border.width?.magnitude ?? 0;
    if (widthPt <= 0) continue;
    const rgb = border.color?.color?.rgbColor;
    const color = rgb ? rgbColorToHex(rgb) : "#000000";
    const isDefaultBlackThin = widthPt <= 0.75 && color === "#000000";
    if (isDefaultBlackThin) continue;
    if (!best || widthPt > best.widthPt) best = { color, widthPt };
  }
  return best;
}

function extractTableRows(table: any): TableCellData[][] {
  const rows: TableCellData[][] = [];
  for (const row of table.tableRows ?? []) {
    const cells: TableCellData[] = [];
    for (const cell of row.tableCells ?? []) {
      const border = getTableCellAccentBorder(cell);
      cells.push({
        text: getTableCellMarkdown(cell),
        backgroundColor: getTableCellBackgroundHex(cell),
        borderColor: border?.color,
        borderWidthPt: border?.widthPt,
      });
    }
    rows.push(cells);
  }
  return rows;
}

function cellLooksLikeCode(cell: any): boolean {
  const plain = getTableCellPlainText(cell);
  const trimmed = plain.trim();
  if (!trimmed) return false;
  if (/[├└│─]/.test(trimmed)) return true; // arvore de pastas
  if (/^[{[]/.test(trimmed)) return true; // JSON
  if (/^(nvm |curl |vtex |npm |yarn |pnpm )/m.test(trimmed)) return true;

  const paragraphs = (cell.content ?? []).filter((el: any) => el.paragraph);
  let sawContent = false;
  for (const el of paragraphs) {
    const text = getParagraphPlainText(el.paragraph);
    if (!text.trim()) continue;
    sawContent = true;
    if (!isWholeLineMonospace(el.paragraph)) return false;
  }
  return sawContent;
}

function tableLooksLikeCodeBlock(table: any): boolean {
  const rows = table.tableRows ?? [];
  if (rows.length !== 1) return false;
  const cells = rows[0]?.tableCells ?? [];
  if (cells.length !== 1) return false;
  return cellLooksLikeCode(cells[0]);
}

// Caixa 1x1 de destaque (callout rosa) — no Obsidian vira > [!tip]
function tableLooksLikeCallout(table: any): boolean {
  if (tableLooksLikeCodeBlock(table)) return false;
  const rows = table.tableRows ?? [];
  if (rows.length !== 1) return false;
  const cells = rows[0]?.tableCells ?? [];
  if (cells.length !== 1) return false;
  const cell = cells[0];
  const plain = getTableCellPlainText(cell).trim();
  if (!plain) return false;
  if (getTableCellBackgroundHex(cell)) return true;
  return /^(por que|dica|aten[cç][aã]o|importante|nota)\b/i.test(plain);
}

function guessCodeLanguage(text: string): string | undefined {
  const t = text.trim();
  if (/^[{\[]/.test(t)) return "json";
  if (/^(nvm |curl |vtex |npm |yarn |pnpm |# )/m.test(t)) return "bash";
  if (/[{};]|@font-face|\.[\w-]+\s*\{/m.test(t)) return "css";
  return undefined;
}

function splitCalloutTitleAndBody(plain: string): { title: string; body: string } {
  const lines = plain.split("\n");
  const title = (lines[0] ?? "").trim() || "Nota";
  const body = lines.slice(1).join("\n").trim();
  return { title, body };
}

// Le doc.namedRanges e monta a lista de trechos marcados com "essa faixa de indices e da linguagem X"
function buildCodeLanguageRanges(doc: any): Array<{ start: number; end: number; language: string }> {
  const namedRanges = doc.namedRanges ?? {};
  const ranges: Array<{ start: number; end: number; language: string }> = [];

  for (const name of Object.keys(namedRanges)) {
    if (!name.startsWith(CODE_LANGUAGE_NAMED_RANGE_PREFIX)) continue;
    const language = name.slice(CODE_LANGUAGE_NAMED_RANGE_PREFIX.length);
    const entries = namedRanges[name]?.namedRanges ?? [];
    for (const entry of entries) {
      for (const range of entry.ranges ?? []) {
        ranges.push({ start: range.startIndex, end: range.endIndex, language });
      }
    }
  }

  return ranges;
}

function findCodeLanguage(
  ranges: Array<{ start: number; end: number; language: string }>,
  index: number
): string | null {
  for (const r of ranges) {
    if (index >= r.start && index < r.end) return r.language;
  }
  return null;
}

// Percorre o body do Doc (paragrafos E tabelas) e classifica cada elemento
function tokenizeDocParagraphs(doc: any, imagePaths?: Map<string, string>): DocToken[] {
  const bodyContent = doc.body?.content ?? [];
  const tokens: DocToken[] = [];

  for (const element of bodyContent) {
    // Tabelas do Docs (callouts, caixas de codigo cinza, Campo/Descricao...) — antes eram puladas
    if (element.table) {
      if (tableLooksLikeCodeBlock(element.table)) {
        const cell = element.table.tableRows[0].tableCells[0];
        const text = getTableCellPlainText(cell);
        tokens.push({
          kind: "code",
          text,
          startIndex: element.startIndex,
          language: guessCodeLanguage(text),
        });
      } else if (tableLooksLikeCallout(element.table)) {
        const cell = element.table.tableRows[0].tableCells[0];
        const { title, body } = splitCalloutTitleAndBody(getTableCellPlainText(cell));
        tokens.push({ kind: "callout", title, body });
      } else {
        tokens.push({ kind: "table", rows: extractTableRows(element.table) });
      }
      continue;
    }

    const paragraph = element.paragraph;
    if (!paragraph) continue;

    const plainText = getParagraphPlainText(paragraph);
    const namedStyle = paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
    const bullet = paragraph.bullet;
    const headingLevel = HEADING_NAMED_STYLES.indexOf(namedStyle) + 1;
    const hasImage = paragraphHasInlineImage(paragraph);

    if (plainText.trim().length === 0 && !bullet && !hasImage) {
      tokens.push({ kind: "empty" });
      continue;
    }

    if (!bullet && namedStyle === "NORMAL_TEXT" && isWholeLineMonospace(paragraph) && !hasImage) {
      tokens.push({ kind: "code", text: plainText, startIndex: element.startIndex });
      continue;
    }

    const spacing = readParagraphSpacing(paragraph);

    // Titulo com bullet residual (heranca do paragrafo sobrevivente no Publish): preferir o titulo,
    // senao o Sync transforma "# Sumario" em item de lista e o proximo Publish cristaliza a corrupcao.
    if (headingLevel > 0) {
      const borderBottomColor = getParagraphBorderBottomColor(paragraph) ?? undefined;
      tokens.push({
        kind: "heading",
        level: headingLevel,
        text: renderParagraphMarkdown(paragraph, imagePaths),
        borderBottomColor,
        spacing,
      });
      continue;
    }

    if (bullet) {
      const listKind = classifyListKind(doc, bullet.listId, bullet.nestingLevel ?? 0);
      tokens.push({
        kind: "bullet",
        listKind,
        text: renderParagraphMarkdown(paragraph, imagePaths),
        spacing,
      });
      continue;
    }

    tokens.push({ kind: "paragraph", text: renderParagraphMarkdown(paragraph, imagePaths), spacing });
  }

  return tokens;
}

// Uma linha em branco entre duas linhas de codigo e uma linha em branco DENTRO do bloco de codigo,
// nao um separador de fora. So da pra saber isso olhando o que vem antes e depois dela.
function reclassifyBlankLinesInsideCode(tokens: DocToken[]): void {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== "empty") continue;

    let before = i - 1;
    while (before >= 0 && tokens[before].kind === "empty") before--;

    let after = i + 1;
    while (after < tokens.length && tokens[after].kind === "empty") after++;

    const beforeIsCode = before >= 0 && tokens[before].kind === "code";
    const afterIsCode = after < tokens.length && tokens[after].kind === "code";

    if (beforeIsCode && afterIsCode) {
      tokens[i] = { kind: "code", text: "" };
    }
  }
}

/** Pasta de midia ao lado da nota: `PastaDaNota/gdocs-media/` (nao na raiz do vault). */
function mediaFolderForNote(file: TFile): string {
  const slash = file.path.lastIndexOf("/");
  if (slash > 0) {
    return `${file.path.slice(0, slash)}/${GDOCS_MEDIA_FOLDER}`;
  }
  return GDOCS_MEDIA_FOLDER;
}

// Percorre os paragrafos do Doc e reconstroi o Markdown: titulos, listas, bloco de codigo, texto, imagens
async function convertDocToMarkdown(
  plugin: GoogleDocsHubPlugin,
  doc: any,
  tabId?: string,
  docId?: string,
  noteFile?: TFile,
  mediaFolderOverride?: string
): Promise<string> {
  const resolved = resolveDocForTab(doc, tabId);
  const objectIds = collectInlineObjectIds(resolved.body?.content ?? []);
  const mediaFolder =
    mediaFolderOverride ??
    (noteFile ? mediaFolderForNote(noteFile) : GDOCS_MEDIA_FOLDER);
  const imagePaths = await downloadDocImagesToVault(plugin, resolved.inlineObjects, objectIds, mediaFolder);

  const tokens = tokenizeDocParagraphs(resolved, imagePaths);
  reclassifyBlankLinesInsideCode(tokens);
  const languageRanges = buildCodeLanguageRanges(resolved);

  const lines: string[] = [];
  let inCodeBlock = false;
  let orderedCounter = 0;

  const closeCodeBlockIfOpen = () => {
    if (inCodeBlock) {
      lines.push("```");
      inCodeBlock = false;
    }
  };

  for (const token of tokens) {
    if (token.kind === "code") {
      if (!inCodeBlock) {
        const namedLang =
          token.startIndex !== undefined ? findCodeLanguage(languageRanges, token.startIndex) : null;
        const language = namedLang ?? token.language ?? null;
        lines.push(language ? "```" + language : "```");
        inCodeBlock = true;
      }
      lines.push(token.text);
      orderedCounter = 0;
      continue;
    }

    closeCodeBlockIfOpen();

    if (token.kind === "empty") {
      orderedCounter = 0;
      lines.push("");
      continue;
    }

    if (token.kind === "callout") {
      orderedCounter = 0;
      lines.push("");
      lines.push(formatCalloutMarkdown(token.title, token.body));
      lines.push("");
      continue;
    }

    if (token.kind === "bullet") {
      // Sempre tira "1. " do texto — senao vira "1. 1. item" quando a lista ja e numerada
      let itemText = token.text;
      let listKind = token.listKind;
      const stripped = stripLeadingManualNumber(itemText);
      if (stripped.ordered) {
        // Prefixo literal "1." no texto so forca numerada se nao for checkbox
        if (listKind !== "checkbox") listKind = "ordered";
        itemText = stripped.content;
      }

      // Normaliza sb minimo no Markdown (Doc com sb=5 parece "grudado"; Sync ja grava o valor folgado)
      const listSpacing: ParagraphSpacing = {
        spaceAbovePt: token.spacing?.spaceAbovePt,
        spaceBelowPt: Math.max(token.spacing?.spaceBelowPt ?? MIN_LIST_SPACE_BELOW_PT, MIN_LIST_SPACE_BELOW_PT),
        lineSpacing: token.spacing?.lineSpacing ?? DEFAULT_LIST_SPACING.lineSpacing,
      };
      const spacingComment = formatSpacingComment(spacingForMarkdownExport(listSpacing) ?? {});
      if (listKind === "ordered") {
        orderedCounter += 1;
        lines.push(`${orderedCounter}. ${itemText}${spacingComment}`);
      } else if (listKind === "checkbox") {
        orderedCounter = 0;
        lines.push(`- [ ] ${itemText}${spacingComment}`);
      } else {
        orderedCounter = 0;
        lines.push(`- ${itemText}${spacingComment}`);
      }
      continue;
    }

    orderedCounter = 0;

    if (token.kind === "table") {
      const tableMd = formatTableMarkdown(token.rows);
      if (tableMd) {
        lines.push("");
        lines.push(tableMd);
        lines.push("");
      }
      continue;
    }

    if (token.kind === "heading") {
      const spacingComment = formatSpacingComment(spacingForMarkdownExport(token.spacing ?? {}) ?? {});
      lines.push(`${"#".repeat(token.level)} ${token.text}${spacingComment}`);
      // Linha embaixo do titulo no Doc → --- no Markdown (o Publish recoloca como borderBottom)
      if (token.borderBottomColor) {
        lines.push("---");
      }
      continue;
    }

    const spacingComment = formatSpacingComment(spacingForMarkdownExport(token.spacing ?? {}) ?? {});
    lines.push(`${token.text}${spacingComment}`);
  }

  closeCodeBlockIfOpen();

  return lines.join("\n");
}

async function docsBatchUpdate(
  plugin: GoogleDocsHubPlugin,
  docId: string,
  requests: unknown[],
  tabId?: string
): Promise<any> {
  if (requests.length === 0) return {};
  const updateResponse = await googleApiFetch(plugin, `${GOOGLE_DOCS_API_URL}/${docId}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: withTabId(requests, tabId) }),
  });
  if (!updateResponse.ok) {
    const errorBody = await updateResponse.text();
    throw new Error(`Falha ao atualizar o Doc (HTTP ${updateResponse.status}): ${errorBody}`);
  }
  return updateResponse.json();
}

function getDocBodyEndIndex(doc: any, tabId?: string): number {
  const { body } = resolveDocForTab(doc, tabId);
  const bodyContent = body?.content ?? [];
  const lastElement = bodyContent[bodyContent.length - 1];
  return lastElement?.endIndex ?? 1;
}

function findLastTableElement(doc: any, tabId?: string): any | null {
  const { body } = resolveDocForTab(doc, tabId);
  const content = body?.content ?? [];
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].table) return content[i];
  }
  return null;
}

function getTableCellInsertIndex(cell: any): number | null {
  for (const el of cell.content ?? []) {
    if (el.paragraph && typeof el.startIndex === "number") {
      return el.startIndex;
    }
  }
  return null;
}

async function clearDocBody(
  plugin: GoogleDocsHubPlugin,
  doc: any,
  docId: string,
  tabId?: string
): Promise<void> {
  const endIndex = getDocBodyEndIndex(doc, tabId);
  const clearBorder = {
    width: { magnitude: 0, unit: "PT" },
    padding: { magnitude: 0, unit: "PT" },
    dashStyle: "SOLID",
    color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
  };
  const requests: unknown[] = [];
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  requests.push({
    deleteParagraphBullets: { range: { startIndex: 1, endIndex: 2 } },
  });
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: 1, endIndex: 2 },
      paragraphStyle: {
        namedStyleType: "NORMAL_TEXT",
        indentStart: { magnitude: 0, unit: "PT" },
        indentFirstLine: { magnitude: 0, unit: "PT" },
        borderTop: clearBorder,
        borderBottom: clearBorder,
        borderLeft: clearBorder,
        borderRight: clearBorder,
      },
      fields: "namedStyleType,indentStart,indentFirstLine,borderTop,borderBottom,borderLeft,borderRight",
    },
  });
  await docsBatchUpdate(plugin, docId, requests, tabId);
}

async function appendBlocksToDoc(
  plugin: GoogleDocsHubPlugin,
  docId: string,
  tabId: string | undefined,
  blocks: MarkdownBlock[]
): Promise<void> {
  if (blocks.length === 0) return;
  const doc = await fetchGoogleDoc(plugin, docId);
  const endIndex = getDocBodyEndIndex(doc, tabId);
  const insertAt = Math.max(1, endIndex - 1);

  const { text, paragraphStyleRequests, spacingRequests, textStyleRequests } =
    buildDocRequestsFromBlocks(blocks, insertAt);
  if (text.length === 0) return;

  await docsBatchUpdate(
    plugin,
    docId,
    [{ insertText: { location: { index: insertAt }, text } }, ...paragraphStyleRequests],
    tabId
  );
  await docsBatchUpdate(plugin, docId, spacingRequests, tabId);
  await docsBatchUpdate(plugin, docId, textStyleRequests, tabId);
}

const CALLOUT_CELL_BG = "#fdf0f5"; // rosa claro tipico das caixas "Dica" / "Por que IO?"
const CODE_CELL_BG = "#f2f2f2"; // caixa cinza de codigo no Docs

function mimeFromExtension(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "svg") return "image/svg+xml";
  return "image/png";
}

function sanitizeDriveFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Sem titulo";
}

async function driveJsonRequest(
  plugin: GoogleDocsHubPlugin,
  url: string,
  options: { method?: string; body?: string } = {}
): Promise<{ ok: boolean; status: number; json: any }> {
  const accessToken = await ensureFreshAccessToken(plugin);
  const response = await requestUrl({
    url,
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body,
    throw: false,
  });
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: response.json,
  };
}

async function findDriveChildFolder(
  plugin: GoogleDocsHubPlugin,
  name: string,
  parentId: string
): Promise<string | null> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q =
    `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
  const url =
    `${GOOGLE_DRIVE_API_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10&spaces=drive`;
  const res = await driveJsonRequest(plugin, url);
  if (!res.ok) return null;
  const files = (res.json?.files ?? []) as Array<{ id?: string }>;
  return files[0]?.id ?? null;
}

async function createDriveFolder(
  plugin: GoogleDocsHubPlugin,
  name: string,
  parentId?: string
): Promise<string> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];

  const res = await driveJsonRequest(plugin, GOOGLE_DRIVE_API_URL, {
    method: "POST",
    body: JSON.stringify(metadata),
  });
  if (!res.ok || !res.json?.id) {
    throw new Error(`Falha ao criar pasta no Drive "${name}" (HTTP ${res.status}).`);
  }
  return res.json.id as string;
}

async function findOrCreateDriveFolder(
  plugin: GoogleDocsHubPlugin,
  name: string,
  parentId: string
): Promise<string> {
  const existing = await findDriveChildFolder(plugin, name, parentId);
  if (existing) return existing;
  return createDriveFolder(plugin, name, parentId);
}

/** Meu Drive / Google Docs Hub / {tituloDoDoc}/ */
async function ensureDocDriveFolder(plugin: GoogleDocsHubPlugin, docTitle: string): Promise<string> {
  await ensureDriveScopeOrThrow(plugin);
  const hubId = await findOrCreateDriveFolder(plugin, DRIVE_HUB_ROOT_FOLDER_NAME, "root");
  return findOrCreateDriveFolder(plugin, sanitizeDriveFolderName(docTitle), hubId);
}

/** Move o Doc pra pasta do hub (exige escopo Drive completo). */
async function tryMoveDriveFileToFolder(
  plugin: GoogleDocsHubPlugin,
  fileId: string,
  folderId: string
): Promise<{ ok: boolean; alreadyThere: boolean; status?: number }> {
  const meta = await driveJsonRequest(plugin, `${GOOGLE_DRIVE_API_URL}/${fileId}?fields=parents`);
  if (!meta.ok) {
    console.warn(`[Google Docs Hub] Nao leu parents do Doc (HTTP ${meta.status}).`, meta.json);
    return { ok: false, alreadyThere: false, status: meta.status };
  }

  const parents: string[] = Array.isArray(meta.json?.parents) ? meta.json.parents : [];
  if (parents.includes(folderId)) return { ok: true, alreadyThere: true };

  const removeParents = parents.length > 0 ? parents.join(",") : "root";
  const url =
    `${GOOGLE_DRIVE_API_URL}/${fileId}?addParents=${encodeURIComponent(folderId)}` +
    `&removeParents=${encodeURIComponent(removeParents)}&fields=id,parents`;
  const moved = await driveJsonRequest(plugin, url, { method: "PATCH", body: "{}" });
  if (!moved.ok) {
    console.warn(`[Google Docs Hub] Falha ao mover Doc (HTTP ${moved.status}).`, moved.json);
  }
  return { ok: moved.ok, alreadyThere: false, status: moved.status };
}

function resolveVaultImageFile(plugin: GoogleDocsHubPlugin, path: string): TFile | null {
  const candidates = [
    path,
    path.replace(new RegExp(`^${GDOCS_MEDIA_FOLDER}/`), `${GDOCS_MEDIA_FOLDER_LEGACY}/`),
    path.replace(new RegExp(`^${GDOCS_MEDIA_FOLDER_LEGACY}/`), `${GDOCS_MEDIA_FOLDER}/`),
  ];
  for (const candidate of candidates) {
    const file = plugin.app.vault.getAbstractFileByPath(candidate);
    if (file instanceof TFile) return file;
  }
  // Busca pelo nome do arquivo se o path relativo falhar (pasta da nota ou raiz legado)
  const base = path.split("/").pop();
  if (base) {
    const match = plugin.app.vault
      .getFiles()
      .find(
        (f) =>
          f.name === base &&
          (f.path.includes(`/${GDOCS_MEDIA_FOLDER}/`) ||
            f.path.startsWith(`${GDOCS_MEDIA_FOLDER}/`) ||
            f.path.includes(`/${GDOCS_MEDIA_FOLDER_LEGACY}/`) ||
            f.path.startsWith(`${GDOCS_MEDIA_FOLDER_LEGACY}/`))
      );
    if (match) return match;
  }
  return null;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function drivePublicImageUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

async function findDriveChildFileByName(
  plugin: GoogleDocsHubPlugin,
  name: string,
  parentId: string
): Promise<string | null> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q =
    `name='${escaped}' and trashed=false and '${parentId}' in parents ` +
    `and mimeType!='application/vnd.google-apps.folder'`;
  const url =
    `${GOOGLE_DRIVE_API_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5&spaces=drive`;
  const res = await driveJsonRequest(plugin, url);
  if (!res.ok) return null;
  const files = (res.json?.files ?? []) as Array<{ id?: string }>;
  return files[0]?.id ?? null;
}

/** MD5 local (Node/Electron) pra casar com md5Checksum do Drive — reaproveita PNG even com nome kix.* novo. */
function md5Hex(data: ArrayBuffer): string | null {
  try {
    // Obsidian desktop: Node crypto disponivel
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require("crypto") as typeof import("crypto");
    return createHash("md5").update(Buffer.from(data)).digest("hex");
  } catch {
    return null;
  }
}

async function findDriveFileInFolderByMd5(
  plugin: GoogleDocsHubPlugin,
  folderId: string,
  md5: string
): Promise<string | null> {
  const q = `trashed=false and '${folderId}' in parents and mimeType contains 'image/'`;
  const url =
    `${GOOGLE_DRIVE_API_URL}?q=${encodeURIComponent(q)}` +
    `&fields=files(id,md5Checksum,name)&pageSize=100&spaces=drive`;
  const res = await driveJsonRequest(plugin, url);
  if (!res.ok) return null;
  const files = (res.json?.files ?? []) as Array<{ id?: string; md5Checksum?: string }>;
  const hit = files.find((f) => (f.md5Checksum ?? "").toLowerCase() === md5.toLowerCase());
  return hit?.id ?? null;
}

async function ensureDriveFileAnyoneReadable(
  plugin: GoogleDocsHubPlugin,
  fileId: string,
  accessToken: string
): Promise<void> {
  const perm = await requestUrl({
    url: `${GOOGLE_DRIVE_API_URL}/${fileId}/permissions`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
    throw: false,
  });
  // 400/409: ja public — ok
  if (perm.status >= 200 && perm.status < 300) return;
  if (perm.status === 400 || perm.status === 409) return;
  throw new Error(
    `Falha ao tornar a imagem publica no Drive (HTTP ${perm.status}). Sem isso o Docs nao consegue buscar a imagem.`
  );
}

async function updateDriveFileMedia(
  plugin: GoogleDocsHubPlugin,
  fileId: string,
  bytes: ArrayBuffer,
  mime: string,
  accessToken: string
): Promise<void> {
  const res = await requestUrl({
    url: `${GOOGLE_DRIVE_UPLOAD_API_URL}/${fileId}?uploadType=media`,
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": mime,
    },
    body: bytes,
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Falha ao atualizar imagem no Drive (HTTP ${res.status}).`);
  }
}

async function rememberDriveImageHash(
  plugin: GoogleDocsHubPlugin,
  hash: string,
  driveId: string
): Promise<void> {
  if (!plugin.settings.driveImageCache) plugin.settings.driveImageCache = {};
  plugin.settings.driveImageCache[hash] = driveId;
  await plugin.saveSettings();
}

/** Sobe a imagem pro Drive (na pasta do Doc), reutiliza se o conteudo ja foi enviado, torna publica. */
async function uploadImageToDriveForDocs(
  plugin: GoogleDocsHubPlugin,
  file: TFile,
  folderId?: string,
  sessionCache?: Map<string, string>
): Promise<string> {
  await ensureDriveScopeOrThrow(plugin);
  const accessToken = await ensureFreshAccessToken(plugin);
  const bytes = await plugin.app.vault.readBinary(file);
  const mime = mimeFromExtension(file.extension);
  const hash = await sha256Hex(bytes);

  if (sessionCache?.has(hash)) {
    return sessionCache.get(hash) as string;
  }

  const finish = async (driveId: string): Promise<string> => {
    await ensureDriveFileAnyoneReadable(plugin, driveId, accessToken);
    await rememberDriveImageHash(plugin, hash, driveId);
    const url = drivePublicImageUrl(driveId);
    sessionCache?.set(hash, url);
    return url;
  };

  // 1) Cache por conteudo (Publish anterior)
  const cachedId = plugin.settings.driveImageCache?.[hash];
  if (cachedId) {
    const check = await driveJsonRequest(
      plugin,
      `${GOOGLE_DRIVE_API_URL}/${cachedId}?fields=id,trashed`
    );
    if (check.ok && check.json?.trashed !== true) {
      return finish(cachedId);
    }
  }

  // 2) Mesmo conteudo ja na pasta (md5) — cobre Sync que gera novo nome kix.*
  if (folderId) {
    const md5 = md5Hex(bytes);
    if (md5) {
      const byMd5 = await findDriveFileInFolderByMd5(plugin, folderId, md5);
      if (byMd5) return finish(byMd5);
    }
  }

  // 3) Mesmo nome ja na pasta do Doc → atualiza midia, nao cria arquivo novo
  if (folderId) {
    const existingId = await findDriveChildFileByName(plugin, file.name, folderId);
    if (existingId) {
      try {
        await updateDriveFileMedia(plugin, existingId, bytes, mime, accessToken);
      } catch (err) {
        console.warn("[Google Docs Hub] Update de midia falhou; reutiliza arquivo existente.", err);
      }
      return finish(existingId);
    }
  }

  // 4) Upload novo
  const metadataObj: Record<string, unknown> = { name: file.name, mimeType: mime };
  if (folderId) metadataObj.parents = [folderId];
  const metadata = JSON.stringify(metadataObj);
  const boundary = "gdocs_hub_" + Date.now().toString(36);
  const metaPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n`;
  const binHeader =
    `--${boundary}\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const metaBytes = new TextEncoder().encode(metaPart);
  const headerBytes = new TextEncoder().encode(binHeader);
  const footerBytes = new TextEncoder().encode(footer);
  const body = new Uint8Array(metaBytes.length + headerBytes.length + bytes.byteLength + footerBytes.length);
  body.set(metaBytes, 0);
  body.set(headerBytes, metaBytes.length);
  body.set(new Uint8Array(bytes), metaBytes.length + headerBytes.length);
  body.set(footerBytes, metaBytes.length + headerBytes.length + bytes.byteLength);

  const upload = await requestUrl({
    url: GOOGLE_DRIVE_UPLOAD_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: body.buffer,
    throw: false,
  });

  if (upload.status < 200 || upload.status >= 300) {
    const detail = typeof upload.json === "object" ? JSON.stringify(upload.json).slice(0, 240) : "";
    if (upload.status === 403) {
      await clearGoogleTokens(plugin);
    }
    throw new Error(
      `Falha ao enviar imagem ao Drive (HTTP ${upload.status}). ` +
        `Rode Connect Google account de novo e aceite Drive. ${detail}`
    );
  }

  const uploaded = upload.json as { id?: string };
  if (!uploaded.id) {
    throw new Error("Drive nao retornou id do arquivo da imagem.");
  }

  return finish(uploaded.id);
}

async function appendImageToDoc(
  plugin: GoogleDocsHubPlugin,
  docId: string,
  tabId: string | undefined,
  imagePath: string,
  driveFolderId?: string,
  sessionCache?: Map<string, string>
): Promise<void> {
  const file = resolveVaultImageFile(plugin, imagePath);
  if (!file) {
    new Notice(`Imagem nao encontrada no vault: ${imagePath}`);
    await appendBlocksToDoc(plugin, docId, tabId, [
      { type: "paragraph", tokens: [{ text: `[imagem ausente: ${imagePath}]` }] },
    ]);
    return;
  }

  const uri = await uploadImageToDriveForDocs(plugin, file, driveFolderId, sessionCache);
  const doc = await fetchGoogleDoc(plugin, docId);
  const endIndex = getDocBodyEndIndex(doc, tabId);
  const insertAt = Math.max(1, endIndex - 1);

  // Quebra de paragrafo antes da imagem (inline image precisa estar dentro de um paragrafo)
  await docsBatchUpdate(
    plugin,
    docId,
    [{ insertText: { location: { index: insertAt }, text: "\n" } }],
    tabId
  );

  const afterBreak = await fetchGoogleDoc(plugin, docId);
  const imageAt = Math.max(1, getDocBodyEndIndex(afterBreak, tabId) - 1);

  await docsBatchUpdate(
    plugin,
    docId,
    [
      {
        insertInlineImage: {
          uri,
          location: { index: imageAt },
        },
      },
    ],
    tabId
  );

  const afterImage = await fetchGoogleDoc(plugin, docId);
  const newlineAt = Math.max(1, getDocBodyEndIndex(afterImage, tabId) - 1);
  await docsBatchUpdate(
    plugin,
    docId,
    [{ insertText: { location: { index: newlineAt }, text: "\n" } }],
    tabId
  );
}

function calloutToTableRows(title: string, body: string): TableCellData[][] {
  const text = body.trim() ? `**${title}**\n${body}` : `**${title}**`;
  return [[{ text, backgroundColor: CALLOUT_CELL_BG }]];
}

function codeBlockToTableRows(text: string): TableCellData[][] {
  return [[{ text, backgroundColor: CODE_CELL_BG, monospace: true }]];
}

async function appendTableToDoc(
  plugin: GoogleDocsHubPlugin,
  docId: string,
  tabId: string | undefined,
  rows: TableCellData[][]
): Promise<void> {
  if (rows.length === 0) return;
  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const normalized = rows.map((r) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push({ text: "" });
    return padded;
  });

  const doc = await fetchGoogleDoc(plugin, docId);
  const endIndex = getDocBodyEndIndex(doc, tabId);
  const insertAt = Math.max(1, endIndex - 1);

  // 1) cria grade vazia
  await docsBatchUpdate(
    plugin,
    docId,
    [
      {
        insertTable: {
          rows: normalized.length,
          columns: colCount,
          location: { index: insertAt },
        },
      },
    ],
    tabId
  );

  // 2) relê o Doc pra achar os startIndex de cada celula
  const updated = await fetchGoogleDoc(plugin, docId);
  const tableElement = findLastTableElement(updated, tabId);
  if (!tableElement?.table || typeof tableElement.startIndex !== "number") return;

  type CellFill = { index: number; plain: string };
  const fills: CellFill[] = [];
  const tableRows = tableElement.table.tableRows ?? [];

  for (let r = 0; r < normalized.length; r++) {
    for (let c = 0; c < colCount; c++) {
      const cell = tableRows[r]?.tableCells?.[c];
      if (!cell) continue;
      const cellIndex = getTableCellInsertIndex(cell);
      const cellData = normalized[r][c];
      if (cellIndex == null) continue;
      const plain = inlineTokensToPlain(cellMarkdownToInlineTokens(cellData.text));
      if (!plain) continue;
      fills.push({ index: cellIndex, plain });
    }
  }

  // 3) preenche de tras pra frente pra os indices nao deslocarem uns aos outros
  fills.sort((a, b) => b.index - a.index);
  if (fills.length > 0) {
    await docsBatchUpdate(
      plugin,
      docId,
      fills.map(({ index, plain }) => ({
        insertText: { location: { index }, text: plain },
      })),
      tabId
    );
  }

  // 4) cores de fundo + estilos inline (negrito/cor/fonte) — relê indices apos insertText
  const styled = await fetchGoogleDoc(plugin, docId);
  const styledTable = findLastTableElement(styled, tabId);
  if (!styledTable?.table || typeof styledTable.startIndex !== "number") return;

  const styleRequests: unknown[] = [];
  const styledRows = styledTable.table.tableRows ?? [];
  for (let r = 0; r < normalized.length; r++) {
    for (let c = 0; c < colCount; c++) {
      const cellData = normalized[r][c];
      const cell = styledRows[r]?.tableCells?.[c];
      if (!cell) continue;

      if (cellData.backgroundColor || cellData.borderColor) {
        const tableCellStyle: Record<string, unknown> = {};
        const fields: string[] = [];
        if (cellData.backgroundColor) {
          tableCellStyle.backgroundColor = {
            color: { rgbColor: hexToRgbColor(cellData.backgroundColor) },
          };
          fields.push("backgroundColor");
        }
        if (cellData.borderColor && (cellData.borderWidthPt ?? 0) > 0) {
          const border = {
            width: { magnitude: cellData.borderWidthPt, unit: "PT" },
            color: { color: { rgbColor: hexToRgbColor(cellData.borderColor) } },
            dashStyle: "SOLID",
          };
          tableCellStyle.borderTop = border;
          tableCellStyle.borderBottom = border;
          tableCellStyle.borderLeft = border;
          tableCellStyle.borderRight = border;
          fields.push("borderTop", "borderBottom", "borderLeft", "borderRight");
        }
        styleRequests.push({
          updateTableCellStyle: {
            tableRange: {
              tableCellLocation: {
                tableStartLocation: { index: styledTable.startIndex },
                rowIndex: r,
                columnIndex: c,
              },
              rowSpan: 1,
              columnSpan: 1,
            },
            tableCellStyle,
            fields: fields.join(","),
          },
        });
      }

      const cellIndex = getTableCellInsertIndex(cell);
      if (cellIndex == null) continue;
      const tokens = cellMarkdownToInlineTokens(cellData.text);
      styleRequests.push(
        ...buildTextStyleRequestsForTokens(tokens, cellIndex, Boolean(cellData.monospace))
      );
    }
  }

  await docsBatchUpdate(plugin, docId, styleRequests, tabId);
}

type HubJobKind = "publish" | "sync" | "merge" | "link" | "tabs";

interface HubProgress {
  set(label: string, percent: number): void;
  tick(label: string): void;
}

/** Conta unidades de trabalho do Publish (cada tabela/img/chunk de texto = 1). */
function countPublishUnits(blocks: MarkdownBlock[]): number {
  const isStructural = (b: MarkdownBlock) =>
    b.type === "table" || b.type === "callout" || b.type === "code" || b.type === "image";
  let units = 0;
  let i = 0;
  while (i < blocks.length) {
    if (isStructural(blocks[i])) {
      units++;
      i++;
      continue;
    }
    while (i < blocks.length && !isStructural(blocks[i])) i++;
    units++;
  }
  return Math.max(units, 1);
}

async function publishNoteToDoc(
  plugin: GoogleDocsHubPlugin,
  doc: any,
  docId: string,
  markdown: string,
  tabId?: string,
  progress?: HubProgress | null
): Promise<void> {
  const blocks = parseMarkdownBlocks(markdown);
  const bodyUnits = countPublishUnits(blocks);
  // pasta + limpar + body
  const totalSteps = 2 + bodyUnits;
  let step = 0;
  const report = (label: string) => {
    step = Math.min(step + 1, totalSteps);
    progress?.set(label, Math.round((step / totalSteps) * 100));
  };

  // Pasta: Meu Drive / Google Docs Hub / {titulo do Doc}/  (Doc + imagens)
  let driveFolderId: string | undefined;
  const hasImages = blocks.some((b) => b.type === "image");
  const folderLabel = sanitizeDriveFolderName(String(doc.title ?? "Sem titulo"));
  progress?.set("Preparando pasta no Drive...", 2);
  try {
    await ensureFullDriveScopeOrThrow(plugin);
    driveFolderId = await ensureDocDriveFolder(plugin, folderLabel);
    const move = await tryMoveDriveFileToFolder(plugin, docId, driveFolderId);
    if (move.ok && !move.alreadyThere) {
      new Notice(`Doc movido para Google Docs Hub / ${folderLabel}`);
    } else if (!move.ok) {
      new Notice(
        `Pasta pronta, mas o Doc nao foi movido (HTTP ${move.status ?? "?"}). Confira o escopo Drive completo.`
      );
    }
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(msg);
    if (hasImages) throw err;
  }
  report("Pasta pronta");

  progress?.set("Limpando o Doc...", Math.round((step / totalSteps) * 100));
  await clearDocBody(plugin, doc, docId, tabId);
  report("Doc limpo");

  const imageSessionCache = new Map<string, string>();

  const isStructural = (b: MarkdownBlock) =>
    b.type === "table" || b.type === "callout" || b.type === "code" || b.type === "image";

  let i = 0;
  let imageIndex = 0;
  const imageTotal = blocks.filter((b) => b.type === "image").length;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "table") {
      progress?.set("Publicando tabela...", Math.round((step / totalSteps) * 100));
      await appendTableToDoc(plugin, docId, tabId, block.rows);
      report("Tabela publicada");
      i++;
      continue;
    }
    if (block.type === "callout") {
      progress?.set("Publicando callout...", Math.round((step / totalSteps) * 100));
      await appendTableToDoc(plugin, docId, tabId, calloutToTableRows(block.title, block.body));
      report("Callout publicado");
      i++;
      continue;
    }
    if (block.type === "code") {
      progress?.set("Publicando codigo...", Math.round((step / totalSteps) * 100));
      await appendTableToDoc(plugin, docId, tabId, codeBlockToTableRows(block.text));
      report("Codigo publicado");
      i++;
      continue;
    }
    if (block.type === "image") {
      imageIndex++;
      progress?.set(
        `Enviando imagem ${imageIndex}/${Math.max(imageTotal, 1)}...`,
        Math.round((step / totalSteps) * 100)
      );
      await appendImageToDoc(plugin, docId, tabId, block.path, driveFolderId, imageSessionCache);
      report(`Imagem ${imageIndex} ok`);
      i++;
      continue;
    }

    const chunk: MarkdownBlock[] = [];
    while (i < blocks.length && !isStructural(blocks[i])) {
      chunk.push(blocks[i]);
      i++;
    }
    progress?.set("Publicando texto...", Math.round((step / totalSteps) * 100));
    await appendBlocksToDoc(plugin, docId, tabId, chunk);
    report("Texto publicado");
  }

  progress?.set("Finalizando...", 98);
}

// Publica sem nenhum conflito pendente: escreve no Doc e atualiza o "carimbo" de ultima sincronizacao
async function runPublishFlow(
  plugin: GoogleDocsHubPlugin,
  file: TFile,
  doc: any,
  docId: string,
  content: string,
  tabId?: string
): Promise<void> {
  if (!plugin.beginJob("publish", "Publicando nota no Google Docs...")) return;
  try {
    await publishNoteToDoc(plugin, doc, docId, content, tabId, plugin.jobProgress ?? undefined);

    plugin.jobProgress?.set("Atualizando metadados...", 99);
    const updatedDoc = await fetchGoogleDoc(plugin, docId);
    const localHash = hashContent(content);
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fm[FRONTMATTER_LAST_SYNCED_REVISION_KEY] = updatedDoc.revisionId;
      fm[FRONTMATTER_LAST_SYNCED_HASH_KEY] = localHash;
    });

    plugin.endJob(true, "Nota publicada com sucesso no Google Docs.");
  } catch (err) {
    console.error(err);
    plugin.endJob(false, `Falha ao publicar: ${(err as Error).message}`);
  }
}

// Sincroniza sem nenhum conflito pendente: traz o Doc pra nota e atualiza o "carimbo" de ultima sincronizacao
async function runSyncFlow(
  plugin: GoogleDocsHubPlugin,
  file: TFile,
  doc: any,
  tabId?: string,
  docId?: string
): Promise<void> {
  if (!plugin.beginJob("sync", "Puxando Google Docs para a nota...")) return;
  try {
    plugin.jobProgress?.set("Lendo o Doc...", 15);
    const docText = await convertDocToMarkdown(plugin, doc, tabId, docId, file);
    const tableCount = (docText.match(/^\| .+\|$/gm) || []).length;
    const codeFenceCount = Math.floor((docText.match(/^```/gm) || []).length / 2);

    plugin.jobProgress?.set("Escrevendo na nota...", 70);
    await plugin.app.vault.process(file, (data) => {
      const frontmatterMatch = data.match(FRONTMATTER_BLOCK_PATTERN);
      const frontmatterBlock = frontmatterMatch ? frontmatterMatch[0] : "";
      return frontmatterBlock + docText;
    });

    plugin.jobProgress?.set("Atualizando metadados...", 90);
    const newHash = hashContent(docText);
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fm[FRONTMATTER_LAST_SYNCED_REVISION_KEY] = doc.revisionId;
      fm[FRONTMATTER_LAST_SYNCED_HASH_KEY] = newHash;
    });

    try {
      await refreshFolderMapaForNote(plugin, file);
    } catch (mapErr) {
      console.warn("Mapa nao atualizado apos Puxar Doc:", mapErr);
    }

    plugin.endJob(
      true,
      `Nota atualizada com o Google Docs` +
        (tableCount || codeFenceCount
          ? ` (${tableCount} linha(s) de tabela, ${codeFenceCount} bloco(s) de codigo).`
          : ".")
    );
  } catch (err) {
    console.error(err);
    plugin.endJob(false, `Falha ao sincronizar: ${(err as Error).message}`);
  }
}

// Aplica o resultado de uma mesclagem manual nos dois lados (nota E Doc), pra ficarem consistentes
async function applyMergedContent(
  plugin: GoogleDocsHubPlugin,
  file: TFile,
  docId: string,
  mergedContent: string,
  tabId?: string
): Promise<void> {
  if (!plugin.beginJob("merge", "Aplicando versão revisada...")) return;
  try {
    const doc = await fetchGoogleDoc(plugin, docId);
    await publishNoteToDoc(plugin, doc, docId, mergedContent, tabId, plugin.jobProgress ?? undefined);

    plugin.jobProgress?.set("Gravando na nota...", 92);
    await plugin.app.vault.process(file, (data) => {
      const frontmatterMatch = data.match(FRONTMATTER_BLOCK_PATTERN);
      const frontmatterBlock = frontmatterMatch ? frontmatterMatch[0] : "";
      return frontmatterBlock + mergedContent;
    });

    const updatedDoc = await fetchGoogleDoc(plugin, docId);
    const mergedHash = hashContent(mergedContent);
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fm[FRONTMATTER_LAST_SYNCED_REVISION_KEY] = updatedDoc.revisionId;
      fm[FRONTMATTER_LAST_SYNCED_HASH_KEY] = mergedHash;
    });

    plugin.endJob(true, "Versão revisada aplicada com sucesso nos dois lados.");
  } catch (err) {
    console.error(err);
    plugin.endJob(false, `Falha ao aplicar a versao revisada: ${(err as Error).message}`);
  }
}

type HunkChoice = "local" | "remote" | "both";

// Janela de revisao de diferencas: mostra vermelho/verde por trecho e deixa escolher o que fica
class MergeReviewModal extends Modal {
  private hunks: MergeHunk[];
  private choices: HunkChoice[];
  private onResolve: (merged: string) => void;

  constructor(
    app: App,
    localContent: string,
    remoteContent: string,
    onResolve: (merged: string) => void,
    defaultChoice: HunkChoice = "remote"
  ) {
    super(app);
    const diff = diffLines(localContent.split("\n"), remoteContent.split("\n"));
    this.hunks = groupIntoHunks(diff);
    // "both" por padrao duplicava nota+Doc (ex: "1. 1. item") e destruia a formatacao
    this.choices = this.hunks.map(() => defaultChoice);
    this.onResolve = onResolve;
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName("Revisar diferencas antes de continuar").setHeading();
    contentEl.createEl("p", {
      text: "A nota e o Google Doc mudaram desde a ultima sincronizacao. Escolha o que fica em cada trecho destacado.",
    });

    const diffContainer = contentEl.createDiv({ cls: "gdocs-hub-diff-container" });

    this.hunks.forEach((hunk, index) => {
      if (hunk.kind === "same") {
        for (const line of hunk.lines) {
          diffContainer.createDiv({
            text: line.length > 0 ? line : " ",
            cls: "gdocs-hub-diff-context",
          });
        }
        return;
      }

      const hunkEl = diffContainer.createDiv({ cls: "gdocs-hub-diff-hunk" });

      for (const line of hunk.localLines) {
        hunkEl.createDiv({ text: `- ${line}`, cls: "gdocs-hub-diff-local" });
      }
      for (const line of hunk.remoteLines) {
        hunkEl.createDiv({ text: `+ ${line}`, cls: "gdocs-hub-diff-remote" });
      }

      const controls = hunkEl.createDiv({ cls: "gdocs-hub-diff-controls" });

      const options: Array<{ value: HunkChoice; label: string }> = [
        { value: "local", label: "Manter a nota" },
        { value: "remote", label: "Manter o Doc" },
        { value: "both", label: "Manter os dois" },
      ];

      const buttons: HTMLButtonElement[] = [];

      const refreshButtons = () => {
        buttons.forEach((btn, i) => {
          btn.toggleClass("mod-cta", options[i].value === this.choices[index]);
        });
      };

      options.forEach((option) => {
        const btn = controls.createEl("button", { text: option.label });
        btn.addEventListener("click", () => {
          this.choices[index] = option.value;
          refreshButtons();
        });
        buttons.push(btn);
      });

      refreshButtons();
    });

    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

    const cancelButton = buttonRow.createEl("button", { text: "Cancelar" });
    cancelButton.addEventListener("click", () => this.close());

    const applyButton = buttonRow.createEl("button", { text: "Aplicar", cls: "mod-cta" });
    applyButton.addEventListener("click", () => {
      const merged = this.buildMergedContent();
      this.close();
      this.onResolve(merged);
    });
  }

  private buildMergedContent(): string {
    const lines: string[] = [];

    this.hunks.forEach((hunk, index) => {
      if (hunk.kind === "same") {
        lines.push(...hunk.lines);
        return;
      }

      const choice = this.choices[index];
      if (choice === "local" || choice === "both") lines.push(...hunk.localLines);
      if (choice === "remote" || choice === "both") lines.push(...hunk.remoteLines);
    });

    return lines.join("\n");
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Logica compartilhada do Publish note: chamada tanto pelo comando (Ctrl+P) quanto pelo botao na nota
async function publishNoteCommand(plugin: GoogleDocsHubPlugin, file: TFile): Promise<void> {
  const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const docId = frontmatter?.[FRONTMATTER_DOC_ID_KEY];
  if (!docId) {
    new Notice("Essa nota ainda nao esta vinculada a um Doc. Rode Link existing Doc primeiro.");
    return;
  }

  const tabId = frontmatter?.[FRONTMATTER_DOC_TAB_ID_KEY];

  try {
    const rawContent = await plugin.app.vault.read(file);
    const content = rawContent.replace(FRONTMATTER_BLOCK_PATTERN, "");
    const doc = await fetchGoogleDoc(plugin, docId);

    const lastRevision = frontmatter?.[FRONTMATTER_LAST_SYNCED_REVISION_KEY];
    const lastHash = frontmatter?.[FRONTMATTER_LAST_SYNCED_HASH_KEY];
    const hasPriorSync = Boolean(lastRevision && lastHash);
    // Compara o conteudo da GUIA especifica, nao o revisionId do documento inteiro - senao, editar
    // outra guia desse mesmo Doc dispararia um aviso de conflito falso nesta nota.
    const remoteContent = await convertDocToMarkdown(plugin, doc, tabId, docId, file);
    const remoteChanged = hasPriorSync && hashContent(remoteContent) !== lastHash;

    if (remoteChanged) {
      // Publish: padrao = manter a nota (o que o usuario esta tentando enviar)
      new MergeReviewModal(
        plugin.app,
        content,
        remoteContent,
        (merged) => {
          void applyMergedContent(plugin, file, docId, merged, tabId);
        },
        "local"
      ).open();
      return;
    }

    await runPublishFlow(plugin, file, doc, docId, content, tabId);
  } catch (err) {
    console.error(err);
    if (await offerUnlinkIfDocGone(plugin, file, err)) return;
    new Notice(`Falha ao publicar: ${(err as Error).message}`);
  }
}

// Logica compartilhada do Sync now: chamada tanto pelo comando (Ctrl+P) quanto pelo botao na nota
async function syncNowCommand(plugin: GoogleDocsHubPlugin, file: TFile): Promise<void> {
  const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const docId = frontmatter?.[FRONTMATTER_DOC_ID_KEY];
  if (!docId) {
    new Notice("Essa nota ainda nao esta vinculada a um Doc. Rode Link existing Doc primeiro.");
    return;
  }

  const tabId = frontmatter?.[FRONTMATTER_DOC_TAB_ID_KEY];

  try {
    const rawContent = await plugin.app.vault.read(file);
    const localContent = rawContent.replace(FRONTMATTER_BLOCK_PATTERN, "");
    const localHash = hashContent(localContent);
    const doc = await fetchGoogleDoc(plugin, docId);

    const lastRevision = frontmatter?.[FRONTMATTER_LAST_SYNCED_REVISION_KEY];
    const lastHash = frontmatter?.[FRONTMATTER_LAST_SYNCED_HASH_KEY];
    const hasPriorSync = Boolean(lastRevision && lastHash);
    const localChanged = hasPriorSync && localHash !== lastHash;

    if (localChanged) {
      const remoteContent = await convertDocToMarkdown(plugin, doc, tabId, docId, file);
      // Sync: padrao = manter o Doc (hub), pra nao perder Calibri/espacamento/linha do titulo
      new MergeReviewModal(
        plugin.app,
        localContent,
        remoteContent,
        (merged) => {
          void applyMergedContent(plugin, file, docId, merged, tabId);
        },
        "remote"
      ).open();
      return;
    }

    await runSyncFlow(plugin, file, doc, tabId, docId);
  } catch (err) {
    console.error(err);
    if (await offerUnlinkIfDocGone(plugin, file, err)) return;
    new Notice(`Falha ao sincronizar: ${(err as Error).message}`);
  }
}

class LinkDocModal extends Modal {
  private onSubmit: (url: string) => void;
  private modalTitle: string;
  private modalDescription: string;
  private buttonLabel: string;

  constructor(
    app: App,
    onSubmit: (url: string) => void,
    options?: { title?: string; description?: string; buttonLabel?: string }
  ) {
    super(app);
    this.onSubmit = onSubmit;
    this.modalTitle = options?.title ?? "Link existing Google Doc";
    this.modalDescription =
      options?.description ?? "Cole a URL completa do Google Doc que voce quer vincular a esta nota.";
    this.buttonLabel = options?.buttonLabel ?? "Link";
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName(this.modalTitle).setHeading();
    contentEl.createEl("p", { text: this.modalDescription });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "https://docs.google.com/document/d/....",
      cls: "gdocs-hub-full-width",
    });
    input.focus();

    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.onSubmit(value);
      this.close();
    };

    input.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter") submit();
    });

    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    const button = buttonRow.createEl("button", { text: this.buttonLabel, cls: "mod-cta" });
    button.addEventListener("click", submit);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Janela que aparece quando o Doc linkado tem mais de uma guia, pra escolher qual guia essa nota segue
class TabSelectionModal extends Modal {
  private tabs: Array<{ tabId: string; title: string }>;
  private onSelect: (tabId: string) => void;
  private onBack?: () => void;

  constructor(
    app: App,
    tabs: Array<{ tabId: string; title: string }>,
    onSelect: (tabId: string) => void,
    onBack?: () => void
  ) {
    super(app);
    this.tabs = tabs;
    this.onSelect = onSelect;
    this.onBack = onBack;
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName("Esse Doc tem varias guias").setHeading();
    contentEl.createEl("p", { text: "Escolha qual guia essa nota deve sincronizar." });

    const listEl = contentEl.createDiv({ cls: "gdocs-hub-scroll-list" });

    for (const tab of this.tabs) {
      const button = listEl.createEl("button", { text: tab.title, cls: "gdocs-hub-block-button" });
      button.addEventListener("click", () => {
        this.close();
        this.onSelect(tab.tabId);
      });
    }

    if (this.onBack) {
      const backButton = contentEl.createEl("button", { text: "Voltar", cls: "gdocs-hub-back-button" });
      backButton.addEventListener("click", () => {
        this.close();
        this.onBack?.();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Janela de escolha quando o Doc tem varias guias: importar todas como notas separadas,
// ou vincular so esta nota a uma guia especifica (que ai sim mostra a lista pra escolher)
class TabChoiceModal extends Modal {
  private onImportAll: () => void;
  private onSelectOne: () => void;

  constructor(app: App, onImportAll: () => void, onSelectOne: () => void) {
    super(app);
    this.onImportAll = onImportAll;
    this.onSelectOne = onSelectOne;
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName("Esse Doc tem varias guias").setHeading();
    contentEl.createEl("p", { text: "O que voce quer fazer?" });

    const importButton = contentEl.createEl("button", {
      text: "Importar todas as guias (uma nota por guia)",
      cls: "mod-cta gdocs-hub-block-button-spaced",
    });
    importButton.addEventListener("click", () => {
      this.close();
      this.onImportAll();
    });

    const selectButton = contentEl.createEl("button", {
      text: "Vincular esta nota a uma guia especifica",
      cls: "gdocs-hub-block-button",
    });
    selectButton.addEventListener("click", () => {
      this.close();
      this.onSelectOne();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

function noteBodyWithoutFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_BLOCK_PATTERN, "");
}

async function writeNoteDocLink(
  plugin: GoogleDocsHubPlugin,
  file: TFile,
  docId: string,
  url: string,
  tabId?: string
): Promise<void> {
  await plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
    frontmatter[FRONTMATTER_DOC_ID_KEY] = docId;
    frontmatter[FRONTMATTER_DOC_URL_KEY] = url;
    if (tabId) frontmatter[FRONTMATTER_DOC_TAB_ID_KEY] = tabId;
    else delete frontmatter[FRONTMATTER_DOC_TAB_ID_KEY];
  });
}

async function createBlankGoogleDoc(
  plugin: GoogleDocsHubPlugin,
  title: string
): Promise<{ docId: string; url: string; doc: any }> {
  await ensureFullDriveScopeOrThrow(plugin);
  const accessToken = await ensureFreshAccessToken(plugin);
  const created = await requestUrl({
    url: GOOGLE_DOCS_API_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
    throw: false,
  });
  if (created.status < 200 || created.status >= 300 || !created.json?.documentId) {
    throw new Error(`Falha ao criar Doc (HTTP ${created.status}).`);
  }
  const docId = created.json.documentId as string;
  const url = `https://docs.google.com/document/d/${docId}/edit`;

  // Organiza no Drive: Google Docs Hub / {titulo}/
  try {
    const folderId = await ensureDocDriveFolder(plugin, title);
    await tryMoveDriveFileToFolder(plugin, docId, folderId);
  } catch (err) {
    console.warn("[Google Docs Hub] Doc criado, mas pasta Drive falhou:", err);
  }

  const doc = await fetchGoogleDoc(plugin, docId);
  return { docId, url, doc };
}

/** Notas .md irmas na mesma pasta (inclui a nota atual). */
/** Notas mapa do vault (ex.: Pastinha_Mapa) nao viram guia no Google Doc. */
function isObsidianMapaNote(file: TFile): boolean {
  return /_Mapa$/i.test(file.basename) || /^00_Mapa/i.test(file.basename);
}

function listSiblingMarkdownNotes(plugin: GoogleDocsHubPlugin, file: TFile): TFile[] {
  const folder = file.parent;
  if (!folder) return [file];
  return folder.children
    .filter((f): f is TFile => {
      if (!(f instanceof TFile) || f.extension !== "md") return false;
      if (isObsidianMapaNote(f)) return false;
      const hubMapa = plugin.app.metadataCache.getFileCache(f)?.frontmatter?.[FRONTMATTER_HUB_MAPA_KEY];
      if (hubMapa === true || hubMapa === "true") return false;
      return true;
    })
    .sort((a, b) => a.basename.localeCompare(b.basename, "pt-BR"));
}

/** Lista imagens dentro de `gdocs-media/` (png/jpg/…). */
function isImageFileName(nameOrExt: string): boolean {
  return /^(png|jpe?g|gif|webp|svg|bmp)$/i.test(nameOrExt.replace(/^\./, "")) ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(nameOrExt);
}

function listGdocsMediaImages(plugin: GoogleDocsHubPlugin, mediaFolderPath: string): TFile[] {
  const folder = plugin.app.vault.getAbstractFileByPath(mediaFolderPath);
  if (folder instanceof TFolder) {
    return folder.children
      .filter((child): child is TFile => {
        if (!(child instanceof TFile)) return false;
        // Obsidian: TFile.extension vem SEM ponto ("png"), nao ".png"
        return isImageFileName(child.extension) || isImageFileName(child.name);
      })
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  const prefix = mediaFolderPath ? `${mediaFolderPath}/` : "";
  return plugin.app.vault
    .getFiles()
    .filter((f) => {
      if (!prefix || !f.path.startsWith(prefix)) return false;
      if (f.path.slice(prefix.length).includes("/")) return false;
      return isImageFileName(f.extension) || isImageFileName(f.name);
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/**
 * Cria/atualiza o mapa DENTRO de `gdocs-media/` (lista as imagens).
 * Ex.: `Pasta/gdocs-media/gdocs-media_Mapa.md`
 */
async function ensureMediaMapaNote(
  plugin: GoogleDocsHubPlugin,
  mediaFolderPath: string
): Promise<string | null> {
  const images = listGdocsMediaImages(plugin, mediaFolderPath);
  if (images.length === 0) return null;

  await ensureVaultFolder(plugin, mediaFolderPath);
  const mapaBase = `${GDOCS_MEDIA_FOLDER}_Mapa`;
  const mapaPath = `${mediaFolderPath}/${mapaBase}.md`;

  const links = images.map((f) => `- [[${f.name}]]`).join("\n");
  const body =
    `---\n` +
    `${FRONTMATTER_HUB_MAPA_KEY}: true\n` +
    `---\n\n` +
    `# ${GDOCS_MEDIA_FOLDER} - Mapa\n\n` +
    `## Imagens\n\n` +
    `${links}\n\n` +
    `---\n` +
    `> Mapa local das imagens baixadas do Google Docs. Não sobe pro Google Docs.\n`;

  const existing = plugin.app.vault.getAbstractFileByPath(mapaPath);
  if (existing instanceof TFile) {
    await plugin.app.vault.modify(existing, body);
  } else {
    await plugin.app.vault.create(mapaPath, body);
  }
  return mapaPath;
}

/** Cria/atualiza `{Pasta}_Mapa.md` local (só Obsidian / grafo). Sem google_doc_*. */
async function ensureFolderMapaNote(
  plugin: GoogleDocsHubPlugin,
  folderPath: string,
  folderName: string,
  notes: TFile[]
): Promise<string> {
  const mapaBase = `${sanitizeFileName(folderName).replace(/\s+/g, "_")}_Mapa`;
  const mapaPath = folderPath ? `${folderPath}/${mapaBase}.md` : `${mapaBase}.md`;

  const links = notes
    .slice()
    .sort((a, b) => a.basename.localeCompare(b.basename, "pt-BR"))
    .map((n) => `- [[${n.basename}]]`)
    .join("\n");

  // Mapa de midia fica DENTRO de gdocs-media; o mapa global só linka esse arquivo
  const mediaFolderPath = folderPath ? `${folderPath}/${GDOCS_MEDIA_FOLDER}` : GDOCS_MEDIA_FOLDER;
  const mediaMapaPath = await ensureMediaMapaNote(plugin, mediaFolderPath);
  const mediaMapaSection = mediaMapaPath
    ? `\n## Mídia\n\n- [[${GDOCS_MEDIA_FOLDER}/${GDOCS_MEDIA_FOLDER}_Mapa|${GDOCS_MEDIA_FOLDER}]]\n`
    : "";

  const body =
    `---\n` +
    `${FRONTMATTER_HUB_MAPA_KEY}: true\n` +
    `---\n\n` +
    `# ${folderName} - Mapa\n\n` +
    `## Notas (guias do Google Doc)\n\n` +
    `${links || "_Nenhuma nota._"}\n` +
    mediaMapaSection +
    `\n---\n` +
    `> Mapa local do Obsidian para o grafo. Não sobe pro Google Docs.\n`;

  const existing = plugin.app.vault.getAbstractFileByPath(mapaPath);
  if (existing instanceof TFile) {
    await plugin.app.vault.modify(existing, body);
  } else {
    const parent = folderPath;
    if (parent) await ensureVaultFolder(plugin, parent);
    await plugin.app.vault.create(mapaPath, body);
  }
  return mapaPath;
}

/** Atualiza o *_Mapa da pasta (notas + imagens) a partir de qualquer nota vinculada. */
async function refreshFolderMapaForNote(plugin: GoogleDocsHubPlugin, file: TFile): Promise<void> {
  const folderPath = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const folderName = folderPath.split("/").filter(Boolean).pop() || "Vault";
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const docId = fm?.[FRONTMATTER_DOC_ID_KEY] as string | undefined;

  const siblings = (
    folderPath
      ? plugin.app.vault.getFiles().filter((f) => {
          const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
          return parent === folderPath && f.extension === "md";
        })
      : plugin.app.vault.getFiles().filter((f) => !f.path.includes("/") && f.extension === "md")
  ).filter((f) => {
    if (isObsidianMapaNote(f)) return false;
    const hub = plugin.app.metadataCache.getFileCache(f)?.frontmatter?.[FRONTMATTER_HUB_MAPA_KEY];
    if (hub === true || hub === "true") return false;
    if (!docId) return true;
    return plugin.app.metadataCache.getFileCache(f)?.frontmatter?.[FRONTMATTER_DOC_ID_KEY] === docId;
  });

  if (siblings.length === 0) return;
  await ensureFolderMapaNote(plugin, folderPath, folderName, siblings);
  // Estrela no grafo: remove arestas nota→imagem (![[wiki]]), deixa só gdocs-media_Mapa→imagem
  for (const note of siblings) {
    try {
      await rewriteGdocsWikiEmbedsToMarkdownImages(plugin, note);
    } catch (err) {
      console.warn("Falha ao normalizar embeds de imagem:", note.path, err);
    }
  }
}

/**
 * Converte ![[...gdocs-media...]] → ![](...) nas notas.
 * Wiki-embed cria link no grafo (floco); markdown image nao.
 */
async function rewriteGdocsWikiEmbedsToMarkdownImages(
  plugin: GoogleDocsHubPlugin,
  file: TFile
): Promise<boolean> {
  const raw = await plugin.app.vault.read(file);
  const next = raw.replace(/!\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
    const path = normalizeImagePath(String(inner).split("|")[0].trim());
    if (!path) return _full;
    const looksMedia =
      path.includes(`/${GDOCS_MEDIA_FOLDER}/`) ||
      path.startsWith(`${GDOCS_MEDIA_FOLDER}/`) ||
      isImageFileName(path);
    if (!looksMedia) return _full;
    return `![](${path})`;
  });
  if (next === raw) return false;
  await plugin.app.vault.modify(file, next);
  return true;
}

async function renameDocTab(
  plugin: GoogleDocsHubPlugin,
  docId: string,
  tabId: string,
  title: string
): Promise<void> {
  // tabId vai DENTRO de tabProperties (nao no root do updateDocumentTabProperties)
  await docsBatchUpdate(plugin, docId, [
    {
      updateDocumentTabProperties: {
        tabProperties: {
          tabId,
          title,
        },
        fields: "title",
      },
    },
  ]);
}

async function addDocTab(
  plugin: GoogleDocsHubPlugin,
  docId: string,
  title: string
): Promise<string> {
  const res = await docsBatchUpdate(plugin, docId, [
    {
      addDocumentTab: {
        tabProperties: { title },
      },
    },
  ]);
  const tabId = res?.replies?.[0]?.addDocumentTab?.tabProperties?.tabId as string | undefined;
  if (!tabId) {
    // Fallback: recarrega o Doc e pega a ultima guia
    const doc = await fetchGoogleDoc(plugin, docId);
    const tabs = listDocTabs(doc);
    const last = tabs[tabs.length - 1]?.tabId;
    if (!last) throw new Error("API nao devolveu tabId da guia criada.");
    return last;
  }
  return tabId;
}

async function publishNoteContentToTab(
  plugin: GoogleDocsHubPlugin,
  file: TFile,
  docId: string,
  tabId: string
): Promise<void> {
  const raw = await plugin.app.vault.read(file);
  const content = noteBodyWithoutFrontmatter(raw);
  const doc = await fetchGoogleDoc(plugin, docId);
  await publishNoteToDoc(plugin, doc, docId, content, tabId, plugin.jobProgress ?? undefined);

  const updated = await fetchGoogleDoc(plugin, docId);
  const hash = hashContent(content);
  await plugin.app.fileManager.processFrontMatter(file, (fm) => {
    fm[FRONTMATTER_LAST_SYNCED_REVISION_KEY] = updated.revisionId;
    fm[FRONTMATTER_LAST_SYNCED_HASH_KEY] = hash;
  });
}

/** Cria Doc so pra nota atual (1 guia). */
async function createDocForSingleNote(plugin: GoogleDocsHubPlugin, file: TFile): Promise<void> {
  if (!plugin.beginJob("link", "Criando Google Doc...")) return;
  try {
    const title = file.basename;
    plugin.jobProgress?.set("Criando Doc no Google...", 10);
    const { docId, url, doc } = await createBlankGoogleDoc(plugin, title);
    const tabs = listDocTabs(doc);
    const tabId = tabs[0]?.tabId;

    plugin.jobProgress?.set("Vinculando nota...", 40);
    if (tabId) {
      try {
        await renameDocTab(plugin, docId, tabId, title);
      } catch (err) {
        console.warn("[Google Docs Hub] Renomear guia falhou; seguindo com o link.", err);
      }
    }
    await writeNoteDocLink(plugin, file, docId, url, tabId);

    plugin.jobProgress?.set("Publicando conteudo...", 55);
    await publishNoteContentToTab(plugin, file, docId, tabId ?? tabs[0]?.tabId);

    plugin.endJob(true, `Doc criado e vinculado: ${title}`);
  } catch (err) {
    console.error(err);
    plugin.endJob(false, `Falha ao criar Doc: ${(err as Error).message}`);
  }
}

/**
 * Cria 1 Doc com 1 guia por nota da pasta (titulo do Doc = nome da pasta).
 * Publica o conteudo de cada nota na guia correspondente.
 */
async function createDocForFolderNotes(
  plugin: GoogleDocsHubPlugin,
  activeFile: TFile,
  notes: TFile[]
): Promise<void> {
  if (!plugin.beginJob("link", "Criando Doc com guias da pasta...")) return;
  try {
    const folderName = activeFile.parent?.name || activeFile.basename;
    plugin.jobProgress?.set("Criando Doc no Google...", 5);
    const { docId, url, doc } = await createBlankGoogleDoc(plugin, folderName);

    let firstTabId = listDocTabs(doc)[0]?.tabId;
    if (!firstTabId) throw new Error("Doc novo sem guia inicial.");

    // Ordena: nota ativa primeiro (fica na 1a guia), resto por nome
    const ordered = [
      activeFile,
      ...notes.filter((n) => n.path !== activeFile.path),
    ];

    const mapping: Array<{ file: TFile; tabId: string }> = [];

    plugin.jobProgress?.set(`Guia 1/${ordered.length}: ${ordered[0].basename}`, 15);
    try {
      await renameDocTab(plugin, docId, firstTabId, ordered[0].basename);
    } catch (err) {
      console.warn("[Google Docs Hub] Renomear 1a guia falhou; seguindo.", err);
    }
    mapping.push({ file: ordered[0], tabId: firstTabId });

    for (let i = 1; i < ordered.length; i++) {
      const note = ordered[i];
      const pct = 15 + Math.round((i / ordered.length) * 35);
      plugin.jobProgress?.set(`Criando guia ${i + 1}/${ordered.length}: ${note.basename}`, pct);
      const tabId = await addDocTab(plugin, docId, note.basename);
      mapping.push({ file: note, tabId });
    }

    for (let i = 0; i < mapping.length; i++) {
      const { file, tabId } = mapping[i];
      const pct = 50 + Math.round((i / mapping.length) * 40);
      plugin.jobProgress?.set(`Publicando ${file.basename}...`, pct);
      await writeNoteDocLink(plugin, file, docId, url, tabId);
      await publishNoteContentToTab(plugin, file, docId, tabId);
    }

    plugin.jobProgress?.set("Criando mapa local...", 95);
    const mapaFolder =
      activeFile.path.includes("/") ? activeFile.path.slice(0, activeFile.path.lastIndexOf("/")) : "";
    const mapaPath = await ensureFolderMapaNote(
      plugin,
      mapaFolder,
      folderName,
      mapping.map((m) => m.file)
    );

    plugin.endJob(
      true,
      `Doc "${folderName}" criado com ${mapping.length} guia(s). Mapa local: ${mapaPath.split("/").pop()}`
    );
  } catch (err) {
    console.error(err);
    plugin.endJob(false, `Falha ao criar Doc da pasta: ${(err as Error).message}`);
  }
}

/** Modal: pasta com varias notas → Doc com guias? */
class CreateDocChoiceModal extends Modal {
  private note: TFile;
  private siblings: TFile[];
  private plugin: GoogleDocsHubPlugin;

  constructor(app: App, plugin: GoogleDocsHubPlugin, note: TFile, siblings: TFile[]) {
    super(app);
    this.plugin = plugin;
    this.note = note;
    this.siblings = siblings;
  }

  onOpen() {
    const { contentEl } = this;
    const folderName = this.note.parent?.name || this.note.parent?.path || "pasta";
    new Setting(contentEl).setName("Criar Google Doc").setHeading();
    contentEl.createEl("p", {
      text:
        `A pasta "${folderName}" tem ${this.siblings.length} notas. ` +
        `Quer criar um Doc no Google com uma guia por nota?`,
    });
    contentEl.createEl("p", {
      text: `Notas: ${this.siblings.map((f) => f.basename).join(", ")}`,
      cls: "gdocs-hub-muted",
    });

    contentEl.createEl("button", {
      text: `Sim: 1 Doc com ${this.siblings.length} guias`,
      cls: "mod-cta gdocs-hub-block-button-spaced",
    }).addEventListener("click", () => {
      this.close();
      void createDocForFolderNotes(this.plugin, this.note, this.siblings);
    });

    contentEl.createEl("button", {
      text: "Não: só esta nota (1 Doc, 1 guia)",
      cls: "gdocs-hub-block-button",
    }).addEventListener("click", () => {
      this.close();
      void createDocForSingleNote(this.plugin, this.note);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

async function startCreateGoogleDocFlow(plugin: GoogleDocsHubPlugin, file: TFile): Promise<void> {
  const existingId = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_DOC_ID_KEY];
  if (existingId) {
    new Notice("Esta nota já está vinculada a um Doc. Use Publicar / Puxar Doc.");
    return;
  }

  // Raiz do vault NÃO conta como pasta (ex.: "Sem título.md" e "SOL.md" juntos).
  // Só pergunta se o path tem pasta real: "Minha Pasta/nota.md"
  const inNamedFolder = file.path.includes("/");
  const siblings = listSiblingMarkdownNotes(plugin, file);
  if (inNamedFolder && siblings.length >= 2) {
    new CreateDocChoiceModal(plugin.app, plugin, file, siblings).open();
    return;
  }
  await createDocForSingleNote(plugin, file);
}

// Logica compartilhada de Link existing Doc: extrai o docId, checa se tem varias guias
// (oferecendo importar todas ou escolher uma) e grava tudo no frontmatter.
// Usada tanto pelo comando quanto pelo botao na nota.
async function linkNoteToDoc(plugin: GoogleDocsHubPlugin, file: TFile, url: string): Promise<void> {
  const docId = extractDocId(url);
  if (!docId) {
    new Notice("URL invalida. Cole o link completo do Google Doc.");
    return;
  }

  const saveLink = async (tabId?: string) => {
    await plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter[FRONTMATTER_DOC_ID_KEY] = docId;
      frontmatter[FRONTMATTER_DOC_URL_KEY] = url;
      if (tabId) {
        frontmatter[FRONTMATTER_DOC_TAB_ID_KEY] = tabId;
      } else {
        delete frontmatter[FRONTMATTER_DOC_TAB_ID_KEY];
      }
    });
    new Notice(`Nota vinculada ao Doc ${docId}`);
  };

  try {
    const doc = await fetchGoogleDoc(plugin, docId);
    const tabs = listDocTabs(doc);

    if (tabs.length <= 1) {
      await saveLink(tabs[0]?.tabId);
      return;
    }

    // Guardada numa funcao pra dar pra "voltar" das telas seguintes sem re-colar a URL
    const showChoice = () => {
      new TabChoiceModal(
        plugin.app,
        () => {
          const defaultFolder = sanitizeFileName(doc.title || "Google Docs Import");
          new ImportFolderModal(
            plugin.app,
            defaultFolder,
            (folderPath) => {
              void runImportAllTabs(plugin, doc, docId, url, tabs, folderPath);
            },
            showChoice
          ).open();
        },
        () => {
          new TabSelectionModal(
            plugin.app,
            tabs,
            (tabId) => {
              void saveLink(tabId);
            },
            showChoice
          ).open();
        }
      ).open();
    };

    showChoice();
  } catch (err) {
    console.error(err);
    new Notice(
      "Nao foi possivel checar as guias do Doc (talvez a conta ainda nao esteja conectada). Vinculando com a primeira guia por padrao."
    );
    await saveLink(undefined);
  }
}

// Troca caracteres invalidos em nome de arquivo por espaco, pra usar o titulo da guia como nome da nota
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() || "Sem titulo";
}

// Janela que pede a pasta destino antes de criar uma nota por guia
class ImportFolderModal extends Modal {
  private defaultPath: string;
  private onSubmit: (folderPath: string) => void;
  private onBack?: () => void;

  constructor(app: App, defaultPath: string, onSubmit: (folderPath: string) => void, onBack?: () => void) {
    super(app);
    this.defaultPath = defaultPath;
    this.onSubmit = onSubmit;
    this.onBack = onBack;
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName("Importar todas as guias").setHeading();
    contentEl.createEl("p", {
      text: "Em qual pasta do vault as notas devem ser criadas (uma nota por guia)?",
    });

    const input = contentEl.createEl("input", { type: "text", cls: "gdocs-hub-full-width" });
    input.value = this.defaultPath;
    input.focus();

    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.onSubmit(value);
      this.close();
    };

    input.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter") submit();
    });

    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

    if (this.onBack) {
      const backButton = buttonRow.createEl("button", { text: "Voltar" });
      backButton.addEventListener("click", () => {
        this.close();
        this.onBack?.();
      });
    }

    const button = buttonRow.createEl("button", { text: "Importar", cls: "mod-cta" });
    button.addEventListener("click", submit);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Cria uma nota por guia dentro da pasta escolhida, cada uma ja linkada e com o conteudo da sua guia
async function runImportAllTabs(
  plugin: GoogleDocsHubPlugin,
  doc: any,
  docId: string,
  docUrl: string,
  tabs: Array<{ tabId: string; title: string }>,
  folderPath: string
): Promise<void> {
  new Notice(`Importando ${tabs.length} guias...`);
  try {
    const result = await syncTabsIntoFolder(plugin, doc, docId, docUrl, tabs, folderPath);
    const skippedMessage = result.skipped > 0 ? `, ${result.skipped} ja existiam e foram puladas` : "";
    const mapaMessage = result.mapaName ? ` Mapa: ${result.mapaName}.` : "";
    new Notice(`Importacao concluida: ${result.created} notas criadas${skippedMessage}.${mapaMessage}`);
  } catch (err) {
    console.error(err);
    new Notice(`Falha ao importar as guias: ${(err as Error).message}`);
  }
}

/**
 * Garante nota por guia na pasta: cria as que faltam, reaproveita as que ja existem (por tab_id ou nome).
 * Atualiza o mapa local. Nao sobrescreve conteudo de notas ja existentes.
 */
async function syncTabsIntoFolder(
  plugin: GoogleDocsHubPlugin,
  doc: any,
  docId: string,
  docUrl: string,
  tabs: Array<{ tabId: string; title: string }>,
  folderPath: string
): Promise<{ created: number; skipped: number; noteFiles: TFile[]; mapaName: string }> {
  const normalizedFolder = folderPath.replace(/\/+$/, "");

  if (normalizedFolder && !plugin.app.vault.getAbstractFileByPath(normalizedFolder)) {
    await ensureVaultFolder(plugin, normalizedFolder);
  }

  const folderFiles = (
    normalizedFolder
      ? plugin.app.vault.getFiles().filter((f) => {
          const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
          return parent === normalizedFolder && f.extension === "md";
        })
      : plugin.app.vault.getFiles().filter((f) => !f.path.includes("/") && f.extension === "md")
  ).filter((f) => !isObsidianMapaNote(f));

  let created = 0;
  let skipped = 0;
  const noteFiles: TFile[] = [];

  for (const tab of tabs) {
    const fileName = sanitizeFileName(tab.title);
    const path = normalizedFolder ? `${normalizedFolder}/${fileName}.md` : `${fileName}.md`;

    const byTabId = folderFiles.find((f) => {
      const fm = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm?.[FRONTMATTER_DOC_ID_KEY] === docId && fm?.[FRONTMATTER_DOC_TAB_ID_KEY] === tab.tabId;
    });
    const byPath = plugin.app.vault.getAbstractFileByPath(path);

    if (byTabId instanceof TFile) {
      skipped++;
      noteFiles.push(byTabId);
      continue;
    }

    if (byPath instanceof TFile) {
      // Nota com mesmo nome: garante vinculo da guia
      await writeNoteDocLink(plugin, byPath, docId, docUrl, tab.tabId);
      skipped++;
      noteFiles.push(byPath);
      continue;
    }

    const content = await convertDocToMarkdown(
      plugin,
      doc,
      tab.tabId,
      docId,
      undefined,
      normalizedFolder ? `${normalizedFolder}/${GDOCS_MEDIA_FOLDER}` : GDOCS_MEDIA_FOLDER
    );
    const frontmatter = [
      "---",
      `${FRONTMATTER_DOC_ID_KEY}: ${docId}`,
      `${FRONTMATTER_DOC_URL_KEY}: ${docUrl}`,
      `${FRONTMATTER_DOC_TAB_ID_KEY}: ${tab.tabId}`,
      "---",
      "",
    ].join("\n");

    const createdFile = await plugin.app.vault.create(path, frontmatter + content);
    noteFiles.push(createdFile);
    created++;
  }

  const folderName =
    normalizedFolder.split("/").filter(Boolean).pop() ||
    sanitizeFileName(String(doc.title ?? "Google Docs"));
  let mapaName = "";
  if (noteFiles.length > 0) {
    const mapaPath = await ensureFolderMapaNote(plugin, normalizedFolder, folderName, noteFiles);
    mapaName = mapaPath.split("/").pop() ?? "";
    for (const note of noteFiles) {
      try {
        await rewriteGdocsWikiEmbedsToMarkdownImages(plugin, note);
      } catch (err) {
        console.warn("Falha ao normalizar embeds de imagem:", note.path, err);
      }
    }
  }

  return { created, skipped, noteFiles, mapaName };
}

/** A partir de uma nota ja vinculada (ou do Mapa da pasta): busca guias novas do Doc, cria notas + atualiza mapa. */
async function updateGuiasFromLinkedNote(plugin: GoogleDocsHubPlugin, file: TFile): Promise<void> {
  const resolved = resolveDocContextForTabUpdate(plugin, file);
  if (!resolved) {
    new Notice("Nao achei Doc vinculado nesta pasta. Abra uma nota com google_doc_id ou o Mapa dela.");
    return;
  }
  const { docId, docUrl, folderPath } = resolved;

  if (!plugin.beginJob("tabs", "Atualizando guias do Doc...")) return;
  try {
    plugin.jobProgress?.set("Lendo guias do Doc...", 20);
    const doc = await fetchGoogleDoc(plugin, docId);
    const tabs = listDocTabs(doc);
    if (tabs.length === 0) {
      plugin.endJob(false, "Esse Doc nao tem guias.");
      return;
    }

    plugin.jobProgress?.set("Sincronizando notas da pasta...", 50);
    const result = await syncTabsIntoFolder(plugin, doc, docId, docUrl, tabs, folderPath);

    plugin.endJob(
      true,
      result.created > 0
        ? `Atualizar guias: ${result.created} nota(s) nova(s). Mapa: ${result.mapaName || "ok"}.`
        : `Nenhuma guia nova. Mapa atualizado (${result.noteFiles.length} nota(s)).`
    );
    plugin.refreshUi();
  } catch (err) {
    console.error(err);
    const unlinkAnchor =
      plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_DOC_ID_KEY]
        ? file
        : null;
    if (unlinkAnchor && (await offerUnlinkIfDocGone(plugin, unlinkAnchor, err))) {
      plugin.endJob(false, "Doc inacessivel.");
      return;
    }
    plugin.endJob(false, `Falha ao atualizar guias: ${(err as Error).message}`);
  }
}

function isHubMapaFile(plugin: GoogleDocsHubPlugin, file: TFile): boolean {
  if (isObsidianMapaNote(file)) return true;
  const hub = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_HUB_MAPA_KEY];
  return hub === true || hub === "true";
}

/** Resolve Doc + pasta para sincronizar guias (nota vinculada ou mapa da pasta). */
function resolveDocContextForTabUpdate(
  plugin: GoogleDocsHubPlugin,
  file: TFile
): { docId: string; docUrl: string; folderPath: string } | null {
  const folderPath = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  let docId = fm?.[FRONTMATTER_DOC_ID_KEY] as string | undefined;
  let docUrl = fm?.[FRONTMATTER_DOC_URL_KEY] as string | undefined;

  if (!docId) {
    const siblings =
      folderPath
        ? plugin.app.vault.getFiles().filter((f) => {
            const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
            return parent === folderPath && f.extension === "md" && !isObsidianMapaNote(f);
          })
        : plugin.app.vault.getFiles().filter((f) => !f.path.includes("/") && f.extension === "md" && !isObsidianMapaNote(f));

    for (const sibling of siblings) {
      const sfm = plugin.app.metadataCache.getFileCache(sibling)?.frontmatter;
      const sid = sfm?.[FRONTMATTER_DOC_ID_KEY] as string | undefined;
      if (sid) {
        docId = sid;
        docUrl = (sfm?.[FRONTMATTER_DOC_URL_KEY] as string | undefined) || docUrl;
        break;
      }
    }
  }

  if (!docId) return null;
  return {
    docId,
    docUrl: docUrl || `https://docs.google.com/document/d/${docId}/edit`,
    folderPath,
  };
}

// Abre o modal que pede a URL do Doc, usado tanto pelo comando quanto pelo icone da ribbon
function openImportAllTabsModal(plugin: GoogleDocsHubPlugin): void {
  new LinkDocModal(
    plugin.app,
    (url) => {
      void importAllTabsAsNotes(plugin, url);
    },
    {
      title: "Importar todas as guias do Doc",
      description: "Cole a URL do Google Doc que tem varias guias. Uma nota sera criada pra cada guia.",
      buttonLabel: "Continuar",
    }
  ).open();
}

// Ponto de entrada do comando: pede a URL, le as guias, e abre o seletor de pasta se houver mais de uma
async function importAllTabsAsNotes(plugin: GoogleDocsHubPlugin, url: string): Promise<void> {
  const docId = extractDocId(url);
  if (!docId) {
    new Notice("URL invalida. Cole o link completo do Google Doc.");
    return;
  }

  new Notice("Lendo as guias do Doc...");

  try {
    const doc = await fetchGoogleDoc(plugin, docId);
    const tabs = listDocTabs(doc);

    if (tabs.length <= 1) {
      new Notice("Esse Doc so tem uma guia. Use o comando Link existing Doc numa nota normal.");
      return;
    }

    const defaultFolder = sanitizeFileName(doc.title || "Google Docs Import");

    new ImportFolderModal(plugin.app, defaultFolder, (folderPath) => {
      void runImportAllTabs(plugin, doc, docId, url, tabs, folderPath);
    }).open();
  } catch (err) {
    console.error(err);
    new Notice(`Falha ao ler as guias do Doc: ${(err as Error).message}`);
  }
}

class GoogleDocsHubSettingTab extends PluginSettingTab {
  plugin: GoogleDocsHubPlugin;

  constructor(app: App, plugin: GoogleDocsHubPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Google Docs Hub").setHeading();

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("ID do cliente OAuth (tipo App para computador) criado no Google Cloud Console.")
      .addText((text) =>
        text
          .setPlaceholder("xxxxx.apps.googleusercontent.com")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Chave secreta do cliente OAuth. Fica salva so localmente, nunca vai pro Git.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("GOCSPX-...")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Status da conta")
      .setDesc(
        this.plugin.settings.refreshToken
          ? tokenHasFullDriveScope((this.plugin.settings.grantedScopes ?? "").split(/\s+/))
            ? "Conectado (Docs + Drive completo)."
            : tokenHasDriveScope((this.plugin.settings.grantedScopes ?? "").split(/\s+/))
              ? "Conectado (Docs + drive.file). Reconecte com Drive completo pra mover Docs."
              : "Conectado, mas SEM Drive. Reconecte pra Publish de imagens."
          : "Ainda nao conectado."
      )
      .addButton((btn) =>
        btn.setButtonText("Desconectar").onClick(async () => {
          await clearGoogleTokens(this.plugin);
          new Notice("Conta Google desconectada.");
          this.display();
        })
      );
  }
}

export default class GoogleDocsHubPlugin extends Plugin {
  settings: GoogleDocsHubSettings;
  private docActionsByView = new Map<MarkdownView, HTMLElement[]>();
  private statusBarEl: HTMLElement | null = null;
  private progressBannerEl: HTMLElement | null = null;
  private jobBusy = false;
  private jobKind: HubJobKind | null = null;
  private jobPercent = 0;
  private jobLabel = "";
  /** Reporter ativo enquanto um job roda (Publish/Sync/Merge). */
  jobProgress: HubProgress | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new GoogleDocsHubSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("gdocs-hub-status");
    this.statusBarEl.setText("Docs Hub");

    console.info(`[Google Docs Hub] loaded v${this.manifest.version}`);
    new Notice(`Google Docs Hub v${this.manifest.version} carregado`);

    this.addCommand({
      id: "connect-google-account",
      name: "Connect Google account",
      callback: async () => {
        const { clientId, clientSecret } = this.settings;
        if (!clientId || !clientSecret) {
          new Notice("Configure o Client ID e o Client Secret em Settings > Google Docs Hub antes de conectar.");
          return;
        }

        await clearGoogleTokens(this);
        new Notice("Abrindo o navegador. Aceite Docs e Drive (imagens)...");

        try {
          const tokens = await runGoogleOAuthFlow(clientId, clientSecret);
          this.settings.accessToken = tokens.accessToken;
          this.settings.refreshToken = tokens.refreshToken;
          this.settings.accessTokenExpiresAt = tokens.expiresAt;
          this.settings.grantedScopes = tokens.grantedScopes;
          await this.saveSettings();
          new Notice("Conta Google conectada (Docs + Drive completo).");
        } catch (err) {
          console.error(err);
          new Notice(`Falha ao conectar: ${(err as Error).message}`);
        }
      },
    });

    this.addCommand({
      id: "publish-note",
      name: "Publish note",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Abra uma nota antes de publicar.");
          return;
        }
        if (this.jobBusy) {
          new Notice("Aguarde: operação em andamento.");
          return;
        }
        void publishNoteCommand(this, file);
      },
    });

    this.addCommand({
      id: "link-existing-doc",
      name: "Link existing Doc",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Abra uma nota antes de vincular um Google Doc.");
          return;
        }

        new LinkDocModal(this.app, (url) => {
          void linkNoteToDoc(this, file, url);
        }).open();
      },
    });

    this.addCommand({
      id: "create-google-doc",
      name: "Create Google Doc from note",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Abra uma nota antes de criar um Google Doc.");
          return;
        }
        void startCreateGoogleDocFlow(this, file);
      },
    });

    this.addCommand({
      id: "import-doc-tabs",
      name: "Import all Doc tabs as notes",
      callback: () => openImportAllTabsModal(this),
    });

    this.addRibbonIcon("folder-input", "Import all Doc tabs as notes (Google Docs Hub)", () => {
      openImportAllTabsModal(this);
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Abra uma nota antes de sincronizar.");
          return;
        }
        if (this.jobBusy) {
          new Notice("Aguarde: operação em andamento.");
          return;
        }
        void syncNowCommand(this, file);
      },
    });

    this.addCommand({
      id: "update-doc-tabs",
      name: "Atualizar guias do Doc",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Abra uma nota vinculada antes de atualizar as guias.");
          return;
        }
        if (this.jobBusy) {
          new Notice("Aguarde: operação em andamento.");
          return;
        }
        void updateGuiasFromLinkedNote(this, file);
      },
    });

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshDocActions()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshDocActions()));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file === file) this.refreshDocActions();
      })
    );
    this.app.workspace.onLayoutReady(() => this.refreshDocActions());
  }

  beginJob(kind: HubJobKind, label: string): boolean {
    if (this.jobBusy) {
      new Notice("Aguarde: já tem Sync/Publish em andamento.");
      return false;
    }
    this.jobBusy = true;
    this.jobKind = kind;
    this.jobLabel = label;
    this.jobPercent = 0;
    this.jobProgress = {
      set: (l, p) => this.updateJobProgress(l, p),
      tick: (l) => this.updateJobProgress(l, Math.min(95, this.jobPercent + 5)),
    };
    this.ensureProgressBanner();
    this.updateJobProgress(label, 0);
    this.refreshDocActions();
    return true;
  }

  updateJobProgress(label: string, percent: number): void {
    this.jobLabel = label;
    this.jobPercent = Math.max(0, Math.min(100, Math.round(percent)));
    this.renderProgressUi();
  }

  endJob(ok: boolean, message: string): void {
    this.jobPercent = 100;
    this.jobLabel = ok ? "Concluído" : "Falhou";
    this.renderProgressUi();

    window.setTimeout(() => {
      this.jobBusy = false;
      this.jobKind = null;
      this.jobProgress = null;
      this.jobPercent = 0;
      this.jobLabel = "";
      this.clearProgressBanner();
      this.renderProgressUi();
      this.refreshDocActions();
    }, ok ? 700 : 1200);

    new Notice(message);
  }

  private ensureProgressBanner(): void {
    this.clearProgressBanner();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const host =
      view.containerEl.querySelector(".view-header") ??
      view.containerEl.querySelector(".workspace-leaf-content") ??
      view.containerEl;

    const banner = host.createDiv({ cls: "gdocs-hub-progress-banner" });
    banner.createDiv({ cls: "gdocs-hub-progress-banner-label" });
    const track = banner.createDiv({ cls: "gdocs-hub-progress-banner-track" });
    track.createDiv({ cls: "gdocs-hub-progress-banner-fill" });
    banner.createDiv({ cls: "gdocs-hub-progress-banner-pct" });
    this.progressBannerEl = banner;
  }

  private clearProgressBanner(): void {
    this.progressBannerEl?.remove();
    this.progressBannerEl = null;
  }

  private renderProgressUi(): void {
    if (this.statusBarEl) {
      if (this.jobBusy) {
        this.statusBarEl.setText(`Docs Hub · ${this.jobPercent}%`);
        this.statusBarEl.addClass("is-busy");
        this.statusBarEl.removeClass("is-ok");
        this.statusBarEl.removeClass("is-err");
      } else {
        this.statusBarEl.setText("Docs Hub");
        this.statusBarEl.removeClass("is-busy");
      }
    }

    const banner = this.progressBannerEl;
    if (!banner) return;
    const labelEl = banner.querySelector(".gdocs-hub-progress-banner-label");
    const fillEl = banner.querySelector(".gdocs-hub-progress-banner-fill");
    const pctEl = banner.querySelector(".gdocs-hub-progress-banner-pct");
    if (labelEl instanceof HTMLElement) labelEl.setText(this.jobLabel || "Processando...");
    if (pctEl instanceof HTMLElement) pctEl.setText(`${this.jobPercent}%`);
    if (fillEl instanceof HTMLElement) {
      fillEl.setCssProps({ width: `${this.jobPercent}%` });
    }
  }

  private addLabeledAction(
    view: MarkdownView,
    icon: string,
    label: string,
    tone: "publish" | "sync" | "link" | "unlink" | "tabs" | "create",
    onClick: () => void,
    opts?: { loading?: boolean; disabled?: boolean }
  ) {
    const el = view.addAction(icon, label, () => {
      if (this.jobBusy || opts?.disabled) {
        new Notice("Aguarde: operação em andamento.");
        return;
      }
      onClick();
    });
    el.addClass("gdocs-hub-action");
    el.addClass(`gdocs-hub-action-${tone}`);
    if (opts?.loading) el.addClass("is-loading");
    if (opts?.disabled || this.jobBusy) el.addClass("is-disabled");

    const spinner = el.createSpan({ cls: "gdocs-hub-action-spinner" });
    spinner.setAttr("aria-hidden", "true");
    el.createSpan({ text: label, cls: "gdocs-hub-action-label" });

    return el;
  }

  private refreshDocActions() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const existing = this.docActionsByView.get(view);
    if (existing) {
      existing.forEach((el) => el.remove());
      this.docActionsByView.delete(view);
    }

    const file = view.file;
    if (!file) return;

    const docId = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_DOC_ID_KEY];
    const busy = this.jobBusy;
    const updatingTabs = busy && this.jobKind === "tabs";

    // Arquivo mapa: Atualizar guias (resolve Doc pelas notas irmas), sem Criar/Vincular
    if (!docId && isHubMapaFile(this, file)) {
      const canUpdate = !!resolveDocContextForTabUpdate(this, file);
      const tabsAction = this.addLabeledAction(
        view,
        "layers",
        updatingTabs ? "Atualizando…" : "Atualizar guias",
        "tabs",
        () => {
          void updateGuiasFromLinkedNote(this, file);
        },
        { loading: updatingTabs, disabled: busy || !canUpdate }
      );
      this.docActionsByView.set(view, [tabsAction]);
      return;
    }

    if (!docId) {
      const createAction = this.addLabeledAction(
        view,
        "file-plus",
        "Criar Doc",
        "create",
        () => {
          void startCreateGoogleDocFlow(this, file);
        },
        { disabled: busy }
      );
      const linkAction = this.addLabeledAction(
        view,
        "link",
        "Vincular Doc",
        "link",
        () => {
          new LinkDocModal(this.app, (url) => {
            void linkNoteToDoc(this, file, url);
          }).open();
        },
        { disabled: busy }
      );
      this.docActionsByView.set(view, [createAction, linkAction]);
      return;
    }

    const publishing = busy && this.jobKind === "publish";
    const syncing = busy && this.jobKind === "sync";
    // Merge (modal de conflito) grava nos dois lados; animação só no Publicar pra nao parecer Puxar
    const merging = busy && this.jobKind === "merge";

    const publishAction = this.addLabeledAction(
      view,
      "upload-cloud",
      publishing ? "Publicando…" : merging ? "Aplicando…" : "Publicar",
      "publish",
      () => {
        void publishNoteCommand(this, file);
      },
      { loading: publishing || merging, disabled: busy }
    );

    const syncAction = this.addLabeledAction(
      view,
      "download-cloud",
      syncing ? "Puxando…" : "Puxar Doc",
      "sync",
      () => {
        void syncNowCommand(this, file);
      },
      { loading: syncing, disabled: busy }
    );

    const tabsAction = this.addLabeledAction(
      view,
      "layers",
      updatingTabs ? "Atualizando…" : "Atualizar guias",
      "tabs",
      () => {
        void updateGuiasFromLinkedNote(this, file);
      },
      { loading: updatingTabs, disabled: busy }
    );

    const unlinkAction = this.addLabeledAction(
      view,
      "unlink",
      "Desvincular",
      "unlink",
      () => {
        new ConfirmUnlinkModal(this.app, file.basename, async (ok) => {
          if (!ok) return;
          await clearNoteDocLink(this, file);
          this.refreshUi();
          new Notice("Nota desvinculada do Google Doc.");
        }).open();
      },
      { disabled: busy }
    );

    this.docActionsByView.set(view, [publishAction, syncAction, tabsAction, unlinkAction]);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Atualiza botoes do header apos desvincular / mudar frontmatter. */
  refreshUi() {
    this.refreshDocActions();
  }

  onunload() {
    this.clearProgressBanner();
    this.docActionsByView.forEach((actions) => actions.forEach((el) => el.remove()));
    this.docActionsByView.clear();
  }
}
