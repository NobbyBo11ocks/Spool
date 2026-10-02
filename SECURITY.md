# Security

## Reporting a vulnerability

Please report security problems privately with GitHub's **Report a vulnerability** button on the Security tab of this
repository, rather than in a public issue. Include what you did, what happened, and the version (see `manifest.json`).

Things that count: a web page being able to make Spool fetch a URL it should not, send your cookies to another site,
start a download, read the extension's data, or inject script or HTML into the popup or downloader.

## Not in scope

Spool does not and will not circumvent DRM. Requests to add that, or to defeat a site's protection of its media, are not
security reports and will be closed.

## How Spool limits what a page can do

- Messages that start downloads or read state are accepted only from the extension's own pages, never from content scripts
  or web pages (`externally_connectable` is not set and nothing is web-accessible).
- A URL a page merely names, on another site, is never fetched by the extension until you choose to download it. Cookies go
  only to the page's own site.
- Everything from a page is inserted as text. Parsers are linear-time with hard caps on input size and counts.
- Only `http(s)` URLs are accepted; file names for Chrome downloads can only carry a known media extension.
