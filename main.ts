import { Notice, Plugin } from "obsidian";

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
        new Notice("Google Docs Hub: Link existing Doc (ainda nao implementado)");
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
