# Changelog

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
