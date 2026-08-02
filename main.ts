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
}

type MarkdownBlock =
  | { type: "heading"; level: number; tokens: InlineToken[] }
  | { type: "bullet"; tokens: InlineToken[] }
  | { type: "numbered"; tokens: InlineToken[] }
  | { type: "paragraph"; tokens: InlineToken[] }
  | { type: "code"; text: string; language?: string }
  | { type: "blank" };

const HEADING_NAMED_STYLES = ["HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"];
const MONOSPACE_FONT_FAMILY = "Courier New";
// Prefixo do Named Range usado pra guardar, de forma invisivel no Doc, qual era a linguagem do bloco de codigo
const CODE_LANGUAGE_NAMED_RANGE_PREFIX = "code-lang:";

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

    const nextSpecial = rest.slice(1).search(/[`\[*_]/);
    const takeLen = nextSpecial === -1 ? rest.length : nextSpecial + 1;
    tokens.push({ text: rest.slice(0, takeLen) });
    i += takeLen;
  }

  return tokens;
}

// Quebra o Markdown inteiro em blocos: titulo, lista, paragrafo, bloco de codigo, linha em branco
function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

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
      blocks.push({ type: "heading", level: headingMatch[1].length, tokens: parseInlineSpans(headingMatch[2]) });
      i++;
      continue;
    }

    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      blocks.push({ type: "bullet", tokens: parseInlineSpans(bulletMatch[1]) });
      i++;
      continue;
    }

    const numberedMatch = /^\d+\.\s+(.*)$/.exec(line);
    if (numberedMatch) {
      blocks.push({ type: "numbered", tokens: parseInlineSpans(numberedMatch[1]) });
      i++;
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    blocks.push({ type: "paragraph", tokens: parseInlineSpans(line) });
    i++;
  }

  return blocks;
}

// Converte os blocos em: (1) o texto puro a inserir e (2) os comandos de formatacao com seus indices exatos
function buildDocRequestsFromMarkdown(markdown: string): { text: string; styleRequests: unknown[] } {
  const blocks = parseMarkdownBlocks(markdown);
  let text = "";
  let cursor = 1; // no Google Docs, o corpo do documento comeca no indice 1
  const styleRequests: unknown[] = [];

  let bulletRunStart: number | null = null;
  let bulletRunOrdered = false;

  const flushBulletRun = (endIndex: number) => {
    if (bulletRunStart === null) return;
    styleRequests.push({
      createParagraphBullets: {
        range: { startIndex: bulletRunStart, endIndex },
        bulletPreset: bulletRunOrdered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
    bulletRunStart = null;
  };

  for (const block of blocks) {
    const isListItem = block.type === "bullet" || block.type === "numbered";
    const isOrdered = block.type === "numbered";

    if (bulletRunStart !== null && (!isListItem || isOrdered !== bulletRunOrdered)) {
      flushBulletRun(cursor);
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
        styleRequests.push({
          updateTextStyle: {
            range: { startIndex: blockStart, endIndex: cursor },
            textStyle: { weightedFontFamily: { fontFamily: MONOSPACE_FONT_FAMILY } },
            fields: "weightedFontFamily",
          },
        });

        // Guarda a linguagem (ex: dataviewjs) de forma invisivel no Doc, pra o Sync now conseguir recuperar depois
        if (block.language) {
          styleRequests.push({
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
      }
      if (token.link) {
        fields.push("link");
        textStyle.link = { url: token.link };
      }

      if (fields.length > 0 && token.text.length > 0) {
        styleRequests.push({
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
      styleRequests.push({
        updateParagraphStyle: {
          range: { startIndex: paragraphStart, endIndex: cursor },
          paragraphStyle: { namedStyleType: HEADING_NAMED_STYLES[block.level - 1] },
          fields: "namedStyleType",
        },
      });
    }

    if (isListItem && bulletRunStart === null) {
      bulletRunStart = paragraphStart;
      bulletRunOrdered = isOrdered;
    }
  }

  flushBulletRun(cursor);

  return { text, styleRequests };
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

// Carimba tabId em todo range/location dos requests, senao o Google aplica na primeira guia por padrao
function withTabId(requests: unknown[], tabId?: string): unknown[] {
  if (!tabId) return requests;

  return requests.map((request) => {
    const clone = JSON.parse(JSON.stringify(request));
    const inner = Object.values(clone)[0] as any;
    if (inner?.range) inner.range.tabId = tabId;
    if (inner?.location) inner.location.tabId = tabId;
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

// Reconstroi a linha em Markdown, aplicando negrito/italico/codigo-inline/link por trecho (textRun)
function renderParagraphMarkdown(paragraph: any): string {
  const elements = paragraph.elements ?? [];
  let markdown = "";

  for (const element of elements) {
    const run = element.textRun;
    if (!run) continue;

    const content = (run.content ?? "").replace(/\n$/, "");
    if (content.length === 0) continue;

    const style = run.textStyle ?? {};
    const isMonospace = style.weightedFontFamily?.fontFamily === MONOSPACE_FONT_FAMILY;

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

    markdown += piece;
  }

  return markdown;
}

// Consulta a lista global do Doc pra saber se esse item e numerado ou so com marcador
function isOrderedListItem(doc: any, listId: string, nestingLevel: number): boolean {
  const level = doc.lists?.[listId]?.listProperties?.nestingLevels?.[nestingLevel];
  return Boolean(level?.glyphType);
}

type DocToken =
  | { kind: "code"; text: string; startIndex?: number }
  | { kind: "empty" }
  | { kind: "bullet"; ordered: boolean; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string };

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

// Percorre os paragrafos do Doc e classifica cada um, sem decidir ainda as linhas em branco ambiguas
function tokenizeDocParagraphs(doc: any): DocToken[] {
  const bodyContent = doc.body?.content ?? [];
  const tokens: DocToken[] = [];

  for (const element of bodyContent) {
    const paragraph = element.paragraph;
    if (!paragraph) continue; // tabelas e outras estruturas ficam de fora por ora

    const plainText = getParagraphPlainText(paragraph);
    const namedStyle = paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
    const bullet = paragraph.bullet;

    if (plainText.trim().length === 0 && !bullet) {
      tokens.push({ kind: "empty" });
      continue;
    }

    if (!bullet && namedStyle === "NORMAL_TEXT" && isWholeLineMonospace(paragraph)) {
      tokens.push({ kind: "code", text: plainText, startIndex: element.startIndex });
      continue;
    }

    if (bullet) {
      const ordered = isOrderedListItem(doc, bullet.listId, bullet.nestingLevel ?? 0);
      tokens.push({ kind: "bullet", ordered, text: renderParagraphMarkdown(paragraph) });
      continue;
    }

    const headingLevel = HEADING_NAMED_STYLES.indexOf(namedStyle) + 1;
    if (headingLevel > 0) {
      tokens.push({ kind: "heading", level: headingLevel, text: renderParagraphMarkdown(paragraph) });
      continue;
    }

    tokens.push({ kind: "paragraph", text: renderParagraphMarkdown(paragraph) });
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
        const language = token.startIndex !== undefined ? findCodeLanguage(languageRanges, token.startIndex) : null;
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

    if (token.kind === "bullet") {
      if (token.ordered) {
        orderedCounter += 1;
        lines.push(`${orderedCounter}. ${token.text}`);
      } else {
        orderedCounter = 0;
        lines.push(`- ${token.text}`);
      }
      continue;
    }

    orderedCounter = 0;

    if (token.kind === "heading") {
      lines.push(`${"#".repeat(token.level)} ${token.text}`);
      continue;
    }

    lines.push(token.text);
  }

  closeCodeBlockIfOpen();

  return lines.join("\n");
}

async function publishNoteToDoc(
  plugin: GoogleDocsHubPlugin,
  doc: any,
  docId: string,
  markdown: string,
  tabId?: string
): Promise<void> {
  const { body } = resolveDocForTab(doc, tabId);
  const bodyContent = body?.content ?? [];
  const lastElement = bodyContent[bodyContent.length - 1];
  const endIndex = lastElement?.endIndex ?? 1;

  const { text, styleRequests } = buildDocRequestsFromMarkdown(markdown);

  const requests: unknown[] = [];

  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }

  if (text.length > 0) {
    requests.push({ insertText: { location: { index: 1 }, text } });
    requests.push(...styleRequests);
  }

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

    new Notice("Nota atualizada com o conteudo do Google Docs.");
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

  constructor(app: App, localContent: string, remoteContent: string, onResolve: (merged: string) => void) {
    super(app);
    const diff = diffLines(localContent.split("\n"), remoteContent.split("\n"));
    this.hunks = groupIntoHunks(diff);
    this.choices = this.hunks.map(() => "both");
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
      new MergeReviewModal(plugin.app, content, remoteContent, (merged) => {
        applyMergedContent(plugin, file, docId, merged, tabId);
      }).open();
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
      new MergeReviewModal(plugin.app, localContent, remoteContent, (merged) => {
        applyMergedContent(plugin, file, docId, merged, tabId);
      }).open();
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

  constructor(app: App, onSubmit: (url: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Link existing Google Doc" });
    contentEl.createEl("p", {
      text: "Cole a URL completa do Google Doc que voce quer vincular a esta nota.",
    });

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
    const button = buttonRow.createEl("button", { text: "Link", cls: "mod-cta" });
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

  constructor(app: App, tabs: Array<{ tabId: string; title: string }>, onSelect: (tabId: string) => void) {
    super(app);
    this.tabs = tabs;
    this.onSelect = onSelect;
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
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Logica compartilhada de Link existing Doc: extrai o docId, checa se tem varias guias (perguntando
// qual, se tiver) e grava tudo no frontmatter. Usada tanto pelo comando quanto pelo botao na nota.
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

    new TabSelectionModal(plugin.app, tabs, async (tabId) => {
      await saveLink(tabId);
    }).open();
  } catch (err) {
    console.error(err);
    new Notice(
      "Nao foi possivel checar as guias do Doc (talvez a conta ainda nao esteja conectada). Vinculando com a primeira guia por padrao."
    );
    await saveLink(undefined);
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
