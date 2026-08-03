import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { randomBytes, createHash } from "crypto";
import * as http from "http";
import { shell } from "electron";

const FRONTMATTER_DOC_ID_KEY = "google_doc_id";
const FRONTMATTER_DOC_URL_KEY = "google_doc_url";
const FRONTMATTER_DOC_TAB_ID_KEY = "google_doc_tab_id";
const FRONTMATTER_LAST_SYNCED_REVISION_KEY = "google_doc_last_synced_revision_id";
const FRONTMATTER_LAST_SYNCED_HASH_KEY = "google_doc_last_synced_content_hash";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DOCS_API_URL = "https://docs.googleapis.com/v1/documents";
const OAUTH_SCOPE = "https://www.googleapis.com/auth/documents";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;
const FRONTMATTER_BLOCK_PATTERN = /^---\n[\s\S]*?\n---\n/;

interface GoogleDocsHubSettings {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
}

const DEFAULT_SETTINGS: GoogleDocsHubSettings = {
  clientId: "",
  clientSecret: "",
};

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface InlineToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
  color?: string;
  fontFamily?: string;
  fontSizePt?: number;
}

// Parseia o atributo style="" de um <span> (color, font-family, font-size)
function parseCssStyleAttr(style: string): { color?: string; fontFamily?: string; fontSizePt?: number } {
  const result: { color?: string; fontFamily?: string; fontSizePt?: number } = {};
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const val = part.slice(colon + 1).trim();
    if (key === "color" && /^#[0-9a-fA-F]{6}$/i.test(val)) {
      result.color = val.toLowerCase();
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
  opts: { color?: string; fontFamily?: string; fontSizePt?: number }
): string {
  const styles: string[] = [];
  if (opts.fontFamily) styles.push(`font-family:${opts.fontFamily}`);
  if (opts.fontSizePt != null) styles.push(`font-size:${opts.fontSizePt}pt`);
  if (opts.color) styles.push(`color:${opts.color}`);
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
  monospace?: boolean; // caixa de codigo 1x1
}

type MarkdownBlock =
  | { type: "heading"; level: number; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "bullet"; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "numbered"; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "paragraph"; tokens: InlineToken[]; spacing?: ParagraphSpacing }
  | { type: "code"; text: string; language?: string }
  | { type: "table"; rows: TableCellData[][] } // HTML/GFM com cor de fundo por celula
  | { type: "callout"; title: string; body: string } // caixa 1x1 tipo "Por que IO?" / dica
  | { type: "hr" } // --- sob o titulo → borderBottom no Google Docs
  | { type: "blank" };

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
          fontFamily: css.fontFamily ?? inner.fontFamily,
          fontSizePt: css.fontSizePt ?? inner.fontSizePt,
        });
      }
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
      const text = cellMatch[2].replace(/<br\s*\/?>/gi, "\n").trim();
      cells.push({ text, backgroundColor: bg });
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
  const hasColors = rows.some((r) => r.some((c) => Boolean(c.backgroundColor)));
  return hasColors ? formatHtmlTable(rows) : formatGfmTable(rows);
}

// HTML com background das celulas — Markdown GFM nao aguenta cor de cabecalho/dica do Docs
function formatHtmlTable(rows: TableCellData[][]): string {
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const normalized = rows.map((r) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push({ text: "" });
    return padded;
  });

  // Primeira linha com fundo = cabecalho (ex.: rosa #e3115e + texto branco no Doc)
  const firstRowIsHeader = normalized[0].some((c) => Boolean(c.backgroundColor));

  const renderCell = (cell: TableCellData, tag: "th" | "td") => {
    const styles: string[] = [];
    if (cell.backgroundColor) styles.push(`background-color:${cell.backgroundColor}`);
    if (tag === "th") {
      styles.push("color:#ffffff", "font-weight:bold");
    }
    const styleAttr = styles.length > 0 ? ` style="${styles.join(";")}"` : "";
    // Celulas ja vem com spans markdown/HTML do Docs; so troca \n por <br>
    const content = cell.text.replace(/\n/g, "<br>");
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
  let bulletRunOrdered = false;
  let lastHeading: { start: number; end: number; color: string | null } | null = null;

  const flushBulletRun = (endIndex: number) => {
    if (bulletRunStart === null) return;
    // endIndex precisa cair no fim do ultimo item (depois do "\n" dele). Se passar para o
    // paragrafo vazio seguinte, o Google cria bullets vazios no fim da lista.
    if (endIndex > bulletRunStart) {
      paragraphStyleRequests.push({
        createParagraphBullets: {
          range: { startIndex: bulletRunStart, endIndex },
          bulletPreset: bulletRunOrdered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }
    bulletRunStart = null;
  };

  for (const block of blocks) {
    // table/callout: insertTable em publishNoteToDoc (API exige re-get entre tabelas)
    if (block.type === "table" || block.type === "callout") continue;

    const isListItem = block.type === "bullet" || block.type === "numbered";
    const isOrdered = block.type === "numbered";

    if (bulletRunStart !== null && (!isListItem || isOrdered !== bulletRunOrdered)) {
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
      bulletRunOrdered = isOrdered;
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
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      shell.openExternal(authUrl.toString());
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Tempo esgotado esperando a autorizacao do Google."));
    }, OAUTH_TIMEOUT_MS);
  });

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
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
  });

  if (!tokenResponse.ok) {
    throw new Error(`Falha ao trocar o code por tokens (HTTP ${tokenResponse.status}).`);
  }

  const tokenData = await tokenResponse.json();

  if (!tokenData.refresh_token) {
    throw new Error(
      "Google nao retornou refresh_token. Revogue o acesso em myaccount.google.com/permissions e tente de novo."
    );
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
  };
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

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Falha ao renovar o token de acesso (HTTP ${response.status}). Tente reconectar a conta.`);
  }

  const data = await response.json();

  plugin.settings.accessToken = data.access_token;
  plugin.settings.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  await plugin.saveSettings();

  return plugin.settings.accessToken as string;
}

async function googleApiFetch(plugin: GoogleDocsHubPlugin, url: string, options: RequestInit = {}): Promise<Response> {
  const accessToken = await ensureFreshAccessToken(plugin);
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

// includeTabsContent=true e obrigatorio pra API devolver o conteudo de TODAS as guias do Doc,
// nao so a primeira (esse e o comportamento padrao do Google se a gente nao pedir explicitamente)
async function fetchGoogleDoc(plugin: GoogleDocsHubPlugin, docId: string): Promise<any> {
  const response = await googleApiFetch(plugin, `${GOOGLE_DOCS_API_URL}/${docId}?includeTabsContent=true`);
  if (!response.ok) {
    throw new Error(
      `Nao foi possivel ler o Doc (HTTP ${response.status}). Confira se o docId esta correto e se voce tem acesso a ele.`
    );
  }
  return response.json();
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
// no mesmo formato { body, lists, namedRanges } que o resto do codigo ja sabe ler
function resolveDocForTab(doc: any, tabId?: string): { body: any; lists: any; namedRanges: any } {
  const flatTabs = flattenDocTabs(doc.tabs);

  if (flatTabs.length === 0) {
    return { body: doc.body, lists: doc.lists, namedRanges: doc.namedRanges };
  }

  const target = (tabId && flatTabs.find((tab) => tab.tabProperties?.tabId === tabId)) || flatTabs[0];
  const documentTab = target.documentTab ?? {};
  return { body: documentTab.body, lists: documentTab.lists, namedRanges: documentTab.namedRanges };
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

// Reconstroi a linha em Markdown, aplicando negrito/italico/fonte/tamanho/cor/link por trecho (textRun)
function renderParagraphMarkdown(paragraph: any): string {
  const elements = paragraph.elements ?? [];
  let markdown = "";

  for (const element of elements) {
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
    // Preserva Calibri/tamanho do Doc no Markdown (senao o Publish joga pra Arial padrao do Heading)
    piece = wrapWithStyleSpan(piece, {
      color,
      fontFamily: !isMonospace && fontFamily ? fontFamily : undefined,
      fontSizePt,
    });

    markdown += piece;
  }

  return markdown;
}

// Consulta a lista global do Doc pra saber se esse item e numerado ou so com marcador.
// Listas numeradas usam glyphType (DECIMAL, ALPHA, ROMAN...); listas com bullet usam glyphSymbol.
const ORDERED_GLYPH_TYPES = new Set([
  "DECIMAL",
  "ZERO_DECIMAL",
  "UPPER_ALPHA",
  "ALPHA",
  "UPPER_ROMAN",
  "ROMAN",
]);

function isOrderedListItem(doc: any, listId: string, nestingLevel: number): boolean {
  const level = doc.lists?.[listId]?.listProperties?.nestingLevels?.[nestingLevel];
  if (!level) return false;
  if (ORDERED_GLYPH_TYPES.has(level.glyphType)) return true;
  // Alguns Docs so trazem glyphFormat ("%0.") sem glyphType preenchido
  return typeof level.glyphFormat === "string" && /%\d/.test(level.glyphFormat);
}

type DocToken =
  | { kind: "code"; text: string; startIndex?: number; language?: string }
  | { kind: "empty" }
  | { kind: "bullet"; ordered: boolean; text: string; spacing?: ParagraphSpacing }
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

function extractTableRows(table: any): TableCellData[][] {
  const rows: TableCellData[][] = [];
  for (const row of table.tableRows ?? []) {
    const cells: TableCellData[] = [];
    for (const cell of row.tableCells ?? []) {
      cells.push({
        text: getTableCellMarkdown(cell),
        backgroundColor: getTableCellBackgroundHex(cell),
      });
    }
    rows.push(cells);
  }
  return rows;
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
function tokenizeDocParagraphs(doc: any): DocToken[] {
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

    if (plainText.trim().length === 0 && !bullet) {
      tokens.push({ kind: "empty" });
      continue;
    }

    if (!bullet && namedStyle === "NORMAL_TEXT" && isWholeLineMonospace(paragraph)) {
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
        text: renderParagraphMarkdown(paragraph),
        borderBottomColor,
        spacing,
      });
      continue;
    }

    if (bullet) {
      const ordered = isOrderedListItem(doc, bullet.listId, bullet.nestingLevel ?? 0);
      tokens.push({ kind: "bullet", ordered, text: renderParagraphMarkdown(paragraph), spacing });
      continue;
    }

    tokens.push({ kind: "paragraph", text: renderParagraphMarkdown(paragraph), spacing });
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

// Percorre os paragrafos do Doc e reconstroi o Markdown: titulos, listas, bloco de codigo, texto normal
function convertDocToMarkdown(doc: any, tabId?: string): string {
  const resolved = resolveDocForTab(doc, tabId);
  const tokens = tokenizeDocParagraphs(resolved);
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
      let ordered = token.ordered;
      const stripped = stripLeadingManualNumber(itemText);
      if (stripped.ordered) {
        ordered = true;
        itemText = stripped.content;
      }

      // Normaliza sb minimo no Markdown (Doc com sb=5 parece "grudado"; Sync ja grava o valor folgado)
      const listSpacing: ParagraphSpacing = {
        spaceAbovePt: token.spacing?.spaceAbovePt,
        spaceBelowPt: Math.max(token.spacing?.spaceBelowPt ?? MIN_LIST_SPACE_BELOW_PT, MIN_LIST_SPACE_BELOW_PT),
        lineSpacing: token.spacing?.lineSpacing ?? DEFAULT_LIST_SPACING.lineSpacing,
      };
      const spacingComment = formatSpacingComment(spacingForMarkdownExport(listSpacing) ?? {});
      if (ordered) {
        orderedCounter += 1;
        lines.push(`${orderedCounter}. ${itemText}${spacingComment}`);
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
): Promise<void> {
  if (requests.length === 0) return;
  const updateResponse = await googleApiFetch(plugin, `${GOOGLE_DOCS_API_URL}/${docId}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: withTabId(requests, tabId) }),
  });
  if (!updateResponse.ok) {
    const errorBody = await updateResponse.text();
    throw new Error(`Falha ao atualizar o Doc (HTTP ${updateResponse.status}): ${errorBody}`);
  }
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

      if (cellData.backgroundColor) {
        styleRequests.push({
          updateTableCellStyle: {
            tableRange: {
              tableCellLocation: {
                tableStartLocation: { index: styledTable.startIndex },
                rowIndex: r,
                columnIndex: c,
              },
              // API exige rowSpan/columnSpan > 0 (omitidos viram 0 → HTTP 400)
              rowSpan: 1,
              columnSpan: 1,
            },
            tableCellStyle: {
              backgroundColor: {
                color: { rgbColor: hexToRgbColor(cellData.backgroundColor) },
              },
            },
            fields: "backgroundColor",
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

async function publishNoteToDoc(
  plugin: GoogleDocsHubPlugin,
  doc: any,
  docId: string,
  markdown: string,
  tabId?: string
): Promise<void> {
  const blocks = parseMarkdownBlocks(markdown);
  await clearDocBody(plugin, doc, docId, tabId);

  const isStructural = (b: MarkdownBlock) =>
    b.type === "table" || b.type === "callout" || b.type === "code";

  // Publica em segmentos: texto/listas, tabelas/callouts/codigo-caixa (API exige re-get)
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "table") {
      await appendTableToDoc(plugin, docId, tabId, block.rows);
      i++;
      continue;
    }
    if (block.type === "callout") {
      await appendTableToDoc(plugin, docId, tabId, calloutToTableRows(block.title, block.body));
      i++;
      continue;
    }
    if (block.type === "code") {
      await appendTableToDoc(plugin, docId, tabId, codeBlockToTableRows(block.text));
      i++;
      continue;
    }

    const chunk: MarkdownBlock[] = [];
    while (i < blocks.length && !isStructural(blocks[i])) {
      chunk.push(blocks[i]);
      i++;
    }
    await appendBlocksToDoc(plugin, docId, tabId, chunk);
  }
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
  new Notice("Publicando nota no Google Docs...");
  try {
    await publishNoteToDoc(plugin, doc, docId, content, tabId);

    const updatedDoc = await fetchGoogleDoc(plugin, docId);
    const localHash = hashContent(content);
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fm[FRONTMATTER_LAST_SYNCED_REVISION_KEY] = updatedDoc.revisionId;
      fm[FRONTMATTER_LAST_SYNCED_HASH_KEY] = localHash;
    });

    new Notice("Nota publicada com sucesso no Google Docs.");
  } catch (err) {
    console.error(err);
    new Notice(`Falha ao publicar: ${(err as Error).message}`);
  }
}

// Sincroniza sem nenhum conflito pendente: traz o Doc pra nota e atualiza o "carimbo" de ultima sincronizacao
async function runSyncFlow(plugin: GoogleDocsHubPlugin, file: TFile, doc: any, tabId?: string): Promise<void> {
  new Notice("Trazendo o conteudo do Google Docs para a nota...");
  try {
    const docText = convertDocToMarkdown(doc, tabId);
    const tableCount = (docText.match(/^\| .+\|$/gm) || []).length;
    const codeFenceCount = Math.floor((docText.match(/^```/gm) || []).length / 2);

    await plugin.app.vault.process(file, (data) => {
      const frontmatterMatch = data.match(FRONTMATTER_BLOCK_PATTERN);
      const frontmatterBlock = frontmatterMatch ? frontmatterMatch[0] : "";
      return frontmatterBlock + docText;
    });

    const newHash = hashContent(docText);
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fm[FRONTMATTER_LAST_SYNCED_REVISION_KEY] = doc.revisionId;
      fm[FRONTMATTER_LAST_SYNCED_HASH_KEY] = newHash;
    });

    new Notice(
      `Nota atualizada com o Google Docs` +
        (tableCount || codeFenceCount
          ? ` (${tableCount} linha(s) de tabela, ${codeFenceCount} bloco(s) de codigo).`
          : ".")
    );
  } catch (err) {
    console.error(err);
    new Notice(`Falha ao sincronizar: ${(err as Error).message}`);
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
  new Notice("Aplicando a versao revisada na nota e no Google Docs...");
  try {
    const doc = await fetchGoogleDoc(plugin, docId);
    await publishNoteToDoc(plugin, doc, docId, mergedContent, tabId);

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

    new Notice("Versao revisada aplicada com sucesso nos dois lados.");
  } catch (err) {
    console.error(err);
    new Notice(`Falha ao aplicar a versao revisada: ${(err as Error).message}`);
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
    contentEl.createEl("h2", { text: "Revisar diferencas antes de continuar" });
    contentEl.createEl("p", {
      text: "A nota e o Google Doc mudaram desde a ultima sincronizacao. Escolha o que fica em cada trecho destacado.",
    });

    const diffContainer = contentEl.createDiv();
    diffContainer.style.maxHeight = "50vh";
    diffContainer.style.overflowY = "auto";
    diffContainer.style.fontFamily = "monospace";
    diffContainer.style.fontSize = "0.85em";
    diffContainer.style.border = "1px solid var(--background-modifier-border)";
    diffContainer.style.borderRadius = "6px";
    diffContainer.style.padding = "8px";

    this.hunks.forEach((hunk, index) => {
      if (hunk.kind === "same") {
        for (const line of hunk.lines) {
          const lineEl = diffContainer.createDiv({ text: line.length > 0 ? line : " " });
          lineEl.style.whiteSpace = "pre-wrap";
          lineEl.style.opacity = "0.6";
        }
        return;
      }

      const hunkEl = diffContainer.createDiv();
      hunkEl.style.margin = "6px 0";
      hunkEl.style.border = "1px solid var(--background-modifier-border)";
      hunkEl.style.borderRadius = "4px";
      hunkEl.style.padding = "4px";

      for (const line of hunk.localLines) {
        const lineEl = hunkEl.createDiv({ text: `- ${line}` });
        lineEl.style.whiteSpace = "pre-wrap";
        lineEl.style.background = "rgba(248, 81, 73, 0.15)";
      }
      for (const line of hunk.remoteLines) {
        const lineEl = hunkEl.createDiv({ text: `+ ${line}` });
        lineEl.style.whiteSpace = "pre-wrap";
        lineEl.style.background = "rgba(63, 185, 80, 0.15)";
      }

      const controls = hunkEl.createDiv();
      controls.style.marginTop = "4px";
      controls.style.display = "flex";
      controls.style.gap = "6px";

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
    const remoteContent = convertDocToMarkdown(doc, tabId);
    const remoteChanged = hasPriorSync && hashContent(remoteContent) !== lastHash;

    if (remoteChanged) {
      // Publish: padrao = manter a nota (o que o usuario esta tentando enviar)
      new MergeReviewModal(
        plugin.app,
        content,
        remoteContent,
        (merged) => {
          applyMergedContent(plugin, file, docId, merged, tabId);
        },
        "local"
      ).open();
      return;
    }

    await runPublishFlow(plugin, file, doc, docId, content, tabId);
  } catch (err) {
    console.error(err);
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
      const remoteContent = convertDocToMarkdown(doc, tabId);
      // Sync: padrao = manter o Doc (hub), pra nao perder Calibri/espacamento/linha do titulo
      new MergeReviewModal(
        plugin.app,
        localContent,
        remoteContent,
        (merged) => {
          applyMergedContent(plugin, file, docId, merged, tabId);
        },
        "remote"
      ).open();
      return;
    }

    await runSyncFlow(plugin, file, doc, tabId);
  } catch (err) {
    console.error(err);
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
    contentEl.createEl("h2", { text: this.modalTitle });
    contentEl.createEl("p", { text: this.modalDescription });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "https://docs.google.com/document/d/....",
    });
    input.style.width = "100%";
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
    contentEl.createEl("h2", { text: "Esse Doc tem varias guias" });
    contentEl.createEl("p", { text: "Escolha qual guia essa nota deve sincronizar." });

    const listEl = contentEl.createDiv();
    listEl.style.maxHeight = "50vh";
    listEl.style.overflowY = "auto";

    for (const tab of this.tabs) {
      const button = listEl.createEl("button", { text: tab.title });
      button.style.display = "block";
      button.style.width = "100%";
      button.style.marginBottom = "6px";
      button.style.textAlign = "left";
      button.addEventListener("click", () => {
        this.close();
        this.onSelect(tab.tabId);
      });
    }

    if (this.onBack) {
      const backButton = contentEl.createEl("button", { text: "Voltar" });
      backButton.style.marginTop = "8px";
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
    contentEl.createEl("h2", { text: "Esse Doc tem varias guias" });
    contentEl.createEl("p", { text: "O que voce quer fazer?" });

    const importButton = contentEl.createEl("button", {
      text: "Importar todas as guias (uma nota por guia)",
      cls: "mod-cta",
    });
    importButton.style.display = "block";
    importButton.style.width = "100%";
    importButton.style.marginBottom = "8px";
    importButton.addEventListener("click", () => {
      this.close();
      this.onImportAll();
    });

    const selectButton = contentEl.createEl("button", {
      text: "Vincular esta nota a uma guia especifica",
    });
    selectButton.style.display = "block";
    selectButton.style.width = "100%";
    selectButton.addEventListener("click", () => {
      this.close();
      this.onSelectOne();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
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
              runImportAllTabs(plugin, doc, docId, url, tabs, folderPath);
            },
            showChoice
          ).open();
        },
        () => {
          new TabSelectionModal(
            plugin.app,
            tabs,
            async (tabId) => {
              await saveLink(tabId);
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
    contentEl.createEl("h2", { text: "Importar todas as guias" });
    contentEl.createEl("p", {
      text: "Em qual pasta do vault as notas devem ser criadas (uma nota por guia)?",
    });

    const input = contentEl.createEl("input", { type: "text" });
    input.value = this.defaultPath;
    input.style.width = "100%";
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

  const normalizedFolder = folderPath.replace(/\/+$/, "");

  try {
    if (normalizedFolder && !plugin.app.vault.getAbstractFileByPath(normalizedFolder)) {
      await plugin.app.vault.createFolder(normalizedFolder);
    }

    let created = 0;
    let skipped = 0;

    for (const tab of tabs) {
      const fileName = sanitizeFileName(tab.title);
      const path = normalizedFolder ? `${normalizedFolder}/${fileName}.md` : `${fileName}.md`;

      if (plugin.app.vault.getAbstractFileByPath(path)) {
        skipped++;
        continue;
      }

      const content = convertDocToMarkdown(doc, tab.tabId);
      const frontmatter = [
        "---",
        `${FRONTMATTER_DOC_ID_KEY}: ${docId}`,
        `${FRONTMATTER_DOC_URL_KEY}: ${docUrl}`,
        `${FRONTMATTER_DOC_TAB_ID_KEY}: ${tab.tabId}`,
        "---",
        "",
      ].join("\n");

      await plugin.app.vault.create(path, frontmatter + content);
      created++;
    }

    const skippedMessage = skipped > 0 ? `, ${skipped} ja existiam e foram puladas` : "";
    new Notice(`Importacao concluida: ${created} notas criadas${skippedMessage}.`);
  } catch (err) {
    console.error(err);
    new Notice(`Falha ao importar as guias: ${(err as Error).message}`);
  }
}

// Abre o modal que pede a URL do Doc, usado tanto pelo comando quanto pelo icone da ribbon
function openImportAllTabsModal(plugin: GoogleDocsHubPlugin): void {
  new LinkDocModal(
    plugin.app,
    (url) => {
      importAllTabsAsNotes(plugin, url);
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
      runImportAllTabs(plugin, doc, docId, url, tabs, folderPath);
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

    containerEl.createEl("h2", { text: "Google Docs Hub" });

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
      .setDesc(this.plugin.settings.refreshToken ? "Conectado." : "Ainda nao conectado.");
  }
}

export default class GoogleDocsHubPlugin extends Plugin {
  settings: GoogleDocsHubSettings;
  private docActionsByView = new Map<MarkdownView, HTMLElement[]>();

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new GoogleDocsHubSettingTab(this.app, this));

    this.addCommand({
      id: "connect-google-account",
      name: "Connect Google account",
      callback: async () => {
        const { clientId, clientSecret } = this.settings;
        if (!clientId || !clientSecret) {
          new Notice("Configure o Client ID e o Client Secret em Settings > Google Docs Hub antes de conectar.");
          return;
        }

        new Notice("Abrindo o navegador para voce autorizar o Google Docs Hub...");

        try {
          const tokens = await runGoogleOAuthFlow(clientId, clientSecret);
          this.settings.accessToken = tokens.accessToken;
          this.settings.refreshToken = tokens.refreshToken;
          this.settings.accessTokenExpiresAt = tokens.expiresAt;
          await this.saveSettings();
          new Notice("Conta Google conectada com sucesso.");
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
        publishNoteCommand(this, file);
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
          linkNoteToDoc(this, file, url);
        }).open();
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
        syncNowCommand(this, file);
      },
    });

    // Botoes na barra de titulo da nota (so aparecem quando a nota tem um Doc vinculado)
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

  // Cria um botao de acao com icone + texto do lado (a barra nativa do Obsidian e so-icone,
  // aqui a gente anexa um <span> de texto manualmente porque foi pedido explicitamente)
  private addLabeledAction(view: MarkdownView, icon: string, label: string, color: string, onClick: () => void) {
    const el = view.addAction(icon, label, onClick);
    el.style.color = color;
    el.style.display = "inline-flex";
    el.style.alignItems = "center";
    el.style.gap = "4px";
    el.style.width = "auto";
    el.style.whiteSpace = "nowrap";

    const textSpan = el.createSpan({ text: label });
    textSpan.style.fontSize = "0.7em";
    textSpan.style.color = "var(--text-muted)";

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

    if (!docId) {
      const linkAction = this.addLabeledAction(view, "link", "Link existing Doc", "#EA4335", () => {
        new LinkDocModal(this.app, (url) => {
          linkNoteToDoc(this, file, url);
        }).open();
      });

      this.docActionsByView.set(view, [linkAction]);
      return;
    }

    const publishAction = this.addLabeledAction(view, "upload-cloud", "Publish note", "#4285F4", () => {
      publishNoteCommand(this, file);
    });

    const syncAction = this.addLabeledAction(view, "download-cloud", "Sync now", "#34A853", () => {
      syncNowCommand(this, file);
    });

    this.docActionsByView.set(view, [publishAction, syncAction]);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    this.docActionsByView.forEach((actions) => actions.forEach((el) => el.remove()));
    this.docActionsByView.clear();
  }
}
