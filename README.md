# YouTube Genie

YouTube Genie is a lightweight web app for bulk editing YouTube video titles and descriptions per playlist.

## Live App

- GitHub Pages: https://jder7.github.io/yt-genie

## Features

- Connect your Google account and authorize YouTube access.
- Load all playlists from the authenticated channel.
- Load all videos from a selected playlist.
- Edit title and description for each video in a review list.
- Export current edits as JSON.
- Import JSON edits from file or drag-and-drop.
- Run batch updates to push modified metadata to YouTube.
- Track estimated quota usage during the current session (not synced with actual quota).

## Tech Stack

- Vanilla HTML, CSS, and JavaScript (no framework, no build step).
- Google Identity Services (OAuth 2.0 token flow).
- YouTube Data API v3 (`playlists.list`, `playlistItems.list`, `videos.list`, `videos.update`).

## Running Locally

Because Google OAuth requires valid origins, run with a local HTTP server instead of opening `index.html` directly.

```bash
python3 -m http.server 8080
```

Then open:

- http://localhost:8080

## Configuration

Open the app and click the settings button (`⚙️`) to configure:

- Google OAuth 2.0 Client ID
- Daily quota limit (for local estimate in UI)

## How To Get A Google OAuth Client ID

1. Open Google Cloud Console: https://console.cloud.google.com/
2. Create a new project (or choose an existing one).
3. In the selected project, enable **YouTube Data API v3**.
4. Configure the OAuth consent screen:
   - User type: External (for personal use in testing mode).
   - Fill required app details.
   - Add your own Google account as a test user.
5. Go to **APIs & Services** -> **Credentials** -> **Create Credentials** -> **OAuth client ID**.
6. Choose **Web application**.
7. Add authorized JavaScript origins:
   - `http://localhost:8080`
   - `https://jder7.github.io`
8. Create the client, then copy the generated Client ID (`...apps.googleusercontent.com`).
9. Paste that value into the app's **Google OAuth 2.0 Client ID** field and save.

## JSON Import/Export Shape

```json
{
  "playlistId": "PL...",
  "playlistTitle": "My Playlist",
  "exportedAt": "2026-04-21T12:00:00.000Z",
  "videos": [
    {
      "videoId": "abc123",
      "title": "New Title",
      "description": "New Description",
      "originalTitle": "Old Title",
      "originalDescription": "Old Description"
    }
  ]
}
```

## Notes

- The app currently focuses on title/description batch operations.
- Quota shown in the UI is an estimate tracked in-session.
