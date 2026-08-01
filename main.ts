import { App, Modal, Notice, Plugin } from "obsidian";

const FRONTMATTER_DOC_ID_KEY = "google_doc_id";
const FRONTMATTER_DOC_URL_KEY = "google_doc_url";

function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
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

export default class GoogleDocsHubPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "connect-google-account",
      name: "Connect Google account",
      callback: () => {
        new Notice("Google Docs Hub: Connect Google account (ainda nao implementado)");
      },
    });

    this.addCommand({
      id: "publish-note",
      name: "Publish note",
      callback: () => {
        new Notice("Google Docs Hub: Publish note (ainda nao implementado)");
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
      callback: () => {
        new Notice("Google Docs Hub: Sync now (ainda nao implementado)");
      },
    });
  }

  onunload() {}
}
