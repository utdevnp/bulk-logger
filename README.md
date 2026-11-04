# Jira Timekeeper

A self-contained Chrome Manifest V3 extension built with React, JavaScript, Vite, and Tailwind CSS. Connect with a Jira Cloud site, Atlassian account email, and API token; issues viewed today are fetched automatically, then time is entered and submitted as one worklog per issue.

## Run locally

```sh
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `dist` folder. Click the extension's toolbar icon to open Jira Timekeeper in Chrome's side panel (Chrome 116 or later).

For UI iteration in a browser, run `npm run dev`.

## Data and permissions

- Jira credentials and the daily draft are stored in `chrome.storage.local` in the user's Chrome profile.
- On each panel open, the saved credentials are reused to fetch Jira issues viewed today; those issues are preloaded into the time-entry list.
- Jira requests are made directly from the extension to the configured Jira site; there is no backend service.
- The extension requests Chrome host access for the configured HTTPS Jira site when connecting.
- The toolbar action opens the extension as a browser side panel.
- Daily drafts reset on the next local calendar day. Successfully submitted tickets remain marked as logged for that day, including when the side panel is closed and reopened.

The extension needs Jira Cloud access for recent issue search and permission to log work on the chosen issues.
