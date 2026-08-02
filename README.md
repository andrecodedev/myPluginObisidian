# Google Docs Hub

Turn a Google Doc into a shared hub for your notes: publish a note to a Google Doc, link a Doc that already exists, and sync changes both ways — with a visual diff to review conflicts before anything gets overwritten.

## Why

Google Docs is often where non-technical collaborators (a manager, a client) read and edit content. This plugin keeps a Markdown note in Obsidian and a Google Doc in sync, so you can write in Obsidian and share a clean, formatted Doc, or bring edits made directly in the Doc back into your vault.

## Features

- **Connect Google account** — one-time OAuth login (desktop loopback flow with PKCE). Your Google password is never seen by the plugin.
- **Link existing Doc** — paste the URL of an existing Google Doc to link it to the current note. Works with Docs you did not create yourself, as long as your account has edit access.
- **Publish note** — sends the note's content to the linked Doc, translating Markdown into real Google Docs formatting: headings (with hierarchy), bold, italic, inline/block code, ordered/unordered lists, and links. Code block language (e.g. `dataviewjs`) is preserved invisibly via a Google Docs Named Range, so it survives a Publish → Sync round trip.
- **Sync now** — reads the Doc back and reconstructs the equivalent Markdown in the note.
- **Conflict detection with visual diff** — before overwriting either side, the plugin compares the current state against the last successful sync (using the Doc's own `revisionId` and a hash of the note's content). If the side that would be overwritten changed, it opens a diff view (added/removed lines, GitHub-style) so you can choose, per changed block, to keep the note's version, the Doc's version, or both.
- **Note-level action buttons**: notes linked to a Doc show Publish/Sync icons in the title bar; unlinked notes show a Link icon — no need to open the command palette for everyday use.

## Setup

1. Create a Google Cloud project and enable the **Google Docs API** and **Google Drive API**.
2. Configure the OAuth consent screen (type: External; it can stay in "Testing" mode for personal or small-team use — add each user's email under "Test users").
3. Create an OAuth Client ID of type **Desktop app**.
4. In Obsidian, go to `Settings → Google Docs Hub` and paste the Client ID and Client Secret.
5. Run the **Connect Google account** command and authorize in the browser window that opens.
6. On any note, run **Link existing Doc** and paste the URL of a Google Doc you have edit access to.

## What this plugin stores locally, and why

- **Client ID / Client Secret**: identify the OAuth application to Google. Entered once in Settings, stored in this plugin's local `data.json`. Never committed to any repository, never sent anywhere except to Google's own OAuth endpoints.
- **Access token / refresh token**: obtained after you authorize through Google's own login screen. Stored locally in the same `data.json`, used only to call the Google Docs API on your behalf. You can revoke access at any time from [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- **Per-note sync metadata** (`google_doc_id`, `google_doc_url`, and the last-synced revision id / content hash): stored in the note's own frontmatter, so the link between a note and a Doc survives renaming or moving the file.

This plugin makes network requests only to `accounts.google.com`, `oauth2.googleapis.com`, and `docs.googleapis.com`, and only when you explicitly run a command (Connect, Publish, or Sync). No analytics, telemetry, or third-party services are used.

## Known limitations

- Tables are not translated between Markdown and Google Docs (Docs' table structure requires a second API round trip that is not implemented yet).
- Obsidian-specific syntax (wikilinks, embeds, plugin-specific code blocks) has no Google Docs equivalent and is kept as literal text.
- Conflict resolution is a two-way diff (note vs. Doc), not a three-way merge against a common ancestor.

## Desktop only

This plugin uses Node's `http`/`crypto` modules and Electron's `shell` API to run the OAuth loopback flow, so it only works on Obsidian desktop.

## License

MIT — see [LICENSE](LICENSE).
