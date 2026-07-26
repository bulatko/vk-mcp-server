# Changelog

## 0.6.1

- The setup guide no longer promises something VK stopped giving. `--login`
  returns a VK ID token (`vk2.a…`), which VK issues to sign a person in and
  keeps most API methods closed to — posting, photos, friends, feeds and
  statistics all answer `1051`, whatever scopes are requested, and the older
  flow that granted full user tokens refuses newly created apps outright. That
  is now said up front, in the README, in the guide, and by `--login` itself
  once it hands the token over
- `--check` names a VK ID token on sight and explains what it reaches, instead
  of leaving it to be discovered one tool at a time
- The hint for error 1051 pointed at a user token as the fix, which is the one
  thing that cannot work. It now points at a community token — the only kind VK
  still lets write
- `--login` accepts the redirect pasted by hand, for a server whose browser
  lives on another machine

## 0.6.0

Breaking: `group_id` is now a string in every tool that takes one. It used to
be a number in three and a string in a fourth, so the model had to guess per
tool — and a short name like `apiclub`, which VK accepts everywhere, only
type-checked against one of them. Numeric IDs keep working; they travel as
text either way, since that is what an HTTP form carries.

- Communities and profiles get cards too. `vk_groups_get_by_id` renders the
  banner, avatar, size and description; `vk_users_get` renders avatar,
  location, following and status, and says plainly when a profile is private
  or deactivated rather than drawing an empty box
- One resource now serves all three shapes and works out which it was handed,
  so the card moved from `ui://vk/wall.html` to `ui://vk/card.html`
- Every `group_id` description says the same thing: an ID or a short name,
  positive, and the minus sign belongs to `owner_id` on a wall, not here

## 0.5.1

- The card handles a single attachment properly: it takes the width and keeps
  its own proportions instead of being cropped into a thumbnail cell, which
  had been cutting the top and bottom off vertical clips. The duration badge
  sits on the picture rather than beside it
- Photos are fetched at the smallest size that still covers a retina render.
  VK offers up to 2560px and the card is never wider than a chat column

## 0.5.0

- `vk_wall_get` now comes with a card. A wall is photos, clips, view counts and
  reactions; handed over as JSON it arrives as a transcription of a feed rather
  than a feed. Hosts that support MCP Apps — Claude, Claude Desktop, VS Code
  Copilot, Goose and others — render the posts with their pictures, video
  previews with durations, and the counters, while the model still receives the
  same structured data. Hosts without the extension ignore the metadata and see
  no difference
- The server serves resources for the first time (`resources/list`,
  `resources/read`), which is what carries the card
- Photos are fetched under a policy that names VK's own origins and nothing
  else; the card makes no network requests of its own. A picture VK has expired
  removes its frame instead of leaving a hole

## 0.4.4

- List results carry a `pagination` block: the total, how many came back, the
  offset they started at, and the offset that continues from there — `null`
  when the page is the last. VK reports a total and hands over one page without
  saying how to reach the next, so the model either stopped at the first page
  believing it had everything, or guessed an offset. The newsfeed, which pages
  by cursor, passes its `next_from` through the same field

## 0.4.3

- The server starts without `VK_ACCESS_TOKEN` and lists its tools. It used to
  exit instead, which broke it in two places: registries introspect a server by
  starting it with an empty environment and reading `tools/list`, so we were
  published as a server with no tools; and anyone who installed the bundle
  before pasting a token watched the process die with the reason on a stream
  their client does not show
- A tool call with no token configured now returns the reason, in the chat,
  naming the variable and how to get a value for it

## 0.4.2

- Tool descriptions rewritten: sixteen of nineteen were under sixty characters
  and named the tool without saying when to use it or what comes back
- The community-ID sign convention is documented on every `owner_id` and
  `group_id` — it is negative on a wall and positive on a group, and getting it
  wrong fails confusingly. `vk_wall_post`, where it matters most, said nothing
- Every tool has a human-readable title; clients no longer display
  `vk_wall_get_by_id`
- New `publish_post` prompt: drafts in the community's own tone, shows the draft
  for approval, then publishes

## 0.4.1

- `docs/SETUP.md`: both routes to a token with the actual screens — a community
  token, which needs no app at all, and a user token via your own app
- `--login` without an App ID prints the three setup steps and the exact
  redirect URI to register
- The one-click installer's token field points at the guide instead of a dead
  OAuth link

## 0.4.0

- `--check` reports which of VK's three token types is configured, who it acts
  as, and which tools it can actually reach. It never calls a write method
- Fifteen VK error codes now carry the fix. Error 8 is the sharpest: the token
  is valid and the app that issued it is blocked, which nothing in VK's message
  says
- Error 5 subcode 1130 is separated out: VK binds a token to the IP that
  authorised it, so a token obtained on a laptop fails on a VPS
- `VK_LOGIN_REDIRECT` lets the login callback return through a public URL, for
  servers that are not the machine running the browser
- `--help`, and a troubleshooting table in the README
- Releases run from a tag push: tests, version consistency across three files,
  bundle, npm, MCP registry, GitHub release — over OIDC, with no stored secrets

## 0.3.1

- `npx vk-mcp-server --login <APP_ID>` walks VK ID's OAuth 2.1 + PKCE flow in
  the browser. VK retired the implicit flow for new apps, so the URL the old
  docs described answers `Security Error`
- `manifest.json` and `server.json` no longer point at a shared VK app that is
  blocked — every token issued through it failed with `error 8`

## 0.3.0

- One-click `.mcpb` bundle: installs in a click, asks for the token in a form
  field, needs no Node.js or config editing
- Structured output on all 19 tools (`outputSchema` + `structuredContent`)
- Failed calls are flagged with `isError` instead of returning error text that
  looks like a result
- Four prompts: community digest, engagement report, audience snapshot,
  community search
- Per-tool icons

## 0.2.0

- Nine new tools: user and community search, community members, joining,
  reactions, and the wall management and photo upload tools from #2
- Omitted arguments no longer reach VK as the literal string `undefined`,
  which affected nearly every tool (#4)
- An explicit `0` is no longer replaced by the default
- Request timeout, backoff on VK's rate limit, and a captcha message that
  explains itself
- MCP tool annotations, so clients can tell reads from writes
- The test suite was replaced: the previous one passed with `src/index.js`
  deleted

## 0.1.2

- Initial public release: 10 tools, MCP registry listing
