# Jira Timekeeper

A self-contained Chrome Manifest V3 extension built with React, JavaScript, Vite, and Tailwind CSS. Connect with a Jira Cloud site, Atlassian account email, and API token; issues viewed today are fetched automatically, then time is entered and submitted as one worklog per issue.

## Run locally

```sh
npm install
npm run build
```

## Find and load the extension in Chrome

After `npm run build`, the unpacked extension is in `dist/` at the root of this project (the folder contains `manifest.json`). In Chrome:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Select **Load unpacked** and choose this project's `dist` folder. Choose `dist`, not the project root.
3. To locate it later, return to `chrome://extensions` and find **Jira Timekeeper** in the installed extensions list. Use the extension's details page to inspect or reload it.
4. To open the app, select Chrome's **Extensions** puzzle-piece button, pin **Jira Timekeeper** if you want it on the toolbar, then click its icon. It opens in Chrome's side panel (Chrome 116 or later).

After rebuilding, return to `chrome://extensions` and select the reload icon on the Jira Timekeeper card to load the updated `dist` files.

## Load the extension in Firefox

Build the Firefox version separately:

```sh
npm run build:firefox
```

This creates `dist-firefox/` with a Firefox-compatible Manifest V3 manifest, background script, and sidebar entry. Do not load the Chrome `dist/` folder in Firefox; it declares Chrome's side-panel permission.

To load it for local development, open `about:debugging#/runtime/this-firefox`, select **This Firefox**, choose **Load Temporary Add-on…**, and select `dist-firefox/manifest.json`. Open Jira Timekeeper from Firefox's sidebar list or click its toolbar button. Temporary add-ons are removed when Firefox closes; load it again after restarting. Rebuild and reload the temporary add-on from `about:debugging` after making changes. For regular installation, the Firefox package must be signed by Mozilla Add-ons.

For UI iteration in a browser, run `npm run dev`.

## Connect to Jira Cloud

1. Open Jira Timekeeper and enter your Jira Cloud site, Atlassian account email, and API token. Enter the site as its host name (for example, `your-team.atlassian.net`); the extension uses HTTPS.
2. Create an API token from [Atlassian account security](https://id.atlassian.com/manage-profile/security/api-tokens). Use a token created for this extension and paste it into the API token field. Treat the token like a password; do not commit it or share it.
3. Select **Connect to Jira**. Chrome will ask to allow the extension to access your Jira site. Grant access, then the extension verifies the credentials by fetching your recent Jira issues and today's worklogs.

To change the site or account later, open **Settings → Jira connection**, enter the new details, and choose **Save and verify connection**. **Disconnect and clear local data** removes the saved credentials and local drafts.

## Authentication

The extension authenticates directly to Jira Cloud's REST API using HTTP Basic authentication with the Atlassian account email as the username and the API token as the password. It sends the credentials over HTTPS from the extension to the Jira site you configured. There is no intermediary server or OAuth flow. The token is saved in `chrome.storage.local` in this Chrome profile so the extension can reconnect when opened; disconnect to remove it. The Atlassian account needs permission to view the relevant issues and read and create worklogs.

## Data and permissions

- Jira credentials and the daily draft are stored in `chrome.storage.local` in the user's Chrome profile.
- On each panel open, the saved credentials are reused to fetch Jira issues viewed today; those issues are preloaded into the time-entry list.
- Jira requests are made directly from the extension to the configured Jira site; there is no backend service.
- The extension requests Chrome host access for the configured HTTPS Jira site when connecting.
- The toolbar action opens the extension as a browser side panel.
- Daily drafts reset on the next local calendar day. Successfully submitted tickets remain marked as logged for that day, including when the side panel is closed and reopened.

The extension needs Jira Cloud access for recent issue search and permission to log work on the chosen issues.
