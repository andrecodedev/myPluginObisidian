import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { randomBytes, createHash } from "crypto";
import * as http from "http";
import { shell } from "electron";

const FRONTMATTER_DOC_ID_KEY = "google_doc_id";
const FRONTMATTER_DOC_URL_KEY = "google_doc_url";

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

function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
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

async function fetchGoogleDoc(plugin: GoogleDocsHubPlugin, docId: string): Promise<any> {
  const response = await googleApiFetch(plugin, `${GOOGLE_DOCS_API_URL}/${docId}`);
  if (!response.ok) {
    throw new Error(
      `Nao foi possivel ler o Doc (HTTP ${response.status}). Confira se o docId esta correto e se voce tem acesso a ele.`
    );
  }
  return response.json();
}

function extractPlainTextFromDoc(doc: any): string {
  const bodyContent = doc.body?.content ?? [];
  let text = "";

  for (const element of bodyContent) {
    const paragraphElements = element.paragraph?.elements ?? [];
    for (const paragraphElement of paragraphElements) {
      if (paragraphElement.textRun?.content) {
        text += paragraphElement.textRun.content;
      }
    }
  }

  return text;
}

async function publishNoteToDoc(plugin: GoogleDocsHubPlugin, docId: string, content: string): Promise<void> {
  const doc = await fetchGoogleDoc(plugin, docId);

  const bodyContent = doc.body?.content ?? [];
  const lastElement = bodyContent[bodyContent.length - 1];
  const endIndex = lastElement?.endIndex ?? 1;

  const requests: unknown[] = [];

  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }

  if (content.length > 0) {
    requests.push({ insertText: { location: { index: 1 }, text: content } });
  }

  if (requests.length === 0) return;

  const updateResponse = await googleApiFetch(plugin, `${GOOGLE_DOCS_API_URL}/${docId}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });

  if (!updateResponse.ok) {
    const errorBody = await updateResponse.text();
    throw new Error(`Falha ao atualizar o Doc (HTTP ${updateResponse.status}): ${errorBody}`);
  }
}

async function pullDocContent(plugin: GoogleDocsHubPlugin, docId: string): Promise<string> {
  const doc = await fetchGoogleDoc(plugin, docId);
  return extractPlainTextFromDoc(doc);
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
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Abra uma nota antes de publicar.");
          return;
        }

        const docId = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_DOC_ID_KEY];
        if (!docId) {
          new Notice("Essa nota ainda nao esta vinculada a um Doc. Rode Link existing Doc primeiro.");
          return;
        }

        new Notice("Publicando nota no Google Docs...");

        try {
          const rawContent = await this.app.vault.read(file);
          const content = rawContent.replace(FRONTMATTER_BLOCK_PATTERN, "");
          await publishNoteToDoc(this, docId, content);
          new Notice("Nota publicada com sucesso no Google Docs.");
        } catch (err) {
          console.error(err);
          new Notice(`Falha ao publicar: ${(err as Error).message}`);
        }
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

        new LinkDocModal(this.app, async (url) => {
          const docId = extractDocId(url);
          if (!docId) {
            new Notice("URL invalida. Cole o link completo do Google Doc.");
            return;
          }

          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            frontmatter[FRONTMATTER_DOC_ID_KEY] = docId;
            frontmatter[FRONTMATTER_DOC_URL_KEY] = url;
          });

          new Notice(`Nota vinculada ao Doc ${docId}`);
        }).open();
      },
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Abra uma nota antes de sincronizar.");
          return;
        }

        const docId = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_DOC_ID_KEY];
        if (!docId) {
          new Notice("Essa nota ainda nao esta vinculada a um Doc. Rode Link existing Doc primeiro.");
          return;
        }

        new Notice("Trazendo o conteudo do Google Docs para a nota...");

        try {
          const docText = await pullDocContent(this, docId);
          await this.app.vault.process(file, (data) => {
            const frontmatterMatch = data.match(FRONTMATTER_BLOCK_PATTERN);
            const frontmatterBlock = frontmatterMatch ? frontmatterMatch[0] : "";
            return frontmatterBlock + docText;
          });
          new Notice("Nota atualizada com o conteudo do Google Docs.");
        } catch (err) {
          console.error(err);
          new Notice(`Falha ao sincronizar: ${(err as Error).message}`);
        }
      },
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {}
}
