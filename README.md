# VK MCP Server

<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/2/21/VK.com-logo.svg" width="100" alt="VK Logo">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vk-mcp-server"><img src="https://img.shields.io/npm/v/vk-mcp-server.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/vk-mcp-server"><img src="https://img.shields.io/npm/dm/vk-mcp-server.svg" alt="npm downloads"></a>
  <a href="https://github.com/bulatko/vk-mcp-server/actions"><img src="https://github.com/bulatko/vk-mcp-server/workflows/CI/badge.svg" alt="CI"></a>
  <a href="https://github.com/bulatko/vk-mcp-server/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/vk-mcp-server.svg" alt="license"></a>
</p>

<p align="center">
  <strong>Model Context Protocol (MCP) server for VK (VKontakte) social network API</strong>
</p>

<p align="center">
  Enables AI assistants like Claude to interact with VK through a standardized interface.
</p>


<p align="center">
<a href="https://glama.ai/mcp/servers/bulatko/vk-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/bulatko/vk-mcp-server/badge" alt="vk-mcp-server MCP server" />
</a>
</p>

---

## Features

- **19 tools** across users, walls, communities, photos, likes and statistics
- **Read and write**: search and read freely; posting, editing and deleting are
  marked as write operations so your client can ask first
- **Structured output**: every tool declares an output schema, so the model gets
  typed data instead of a JSON blob it has to parse out of text
- **Prompts**: ready-made workflows — community digest, engagement report,
  audience snapshot, community search
- **Resilient**: request timeouts, automatic backoff when VK rate-limits, and
  clear messages for captchas and HTTP failures
- **Tested**: 44 tests driving the real server over the MCP protocol

## Quick Start

### Claude Desktop — one click

Download the latest `.mcpb` bundle from the
[releases page](https://github.com/bulatko/vk-mcp-server/releases/latest) and
open it. It installs the server, asks for your VK token in a form field, and
stores it securely — no Node.js, no config files, no terminal.

### VS Code — one click

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_VK_MCP-0098FF?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22vk%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22vk-mcp-server%22%5D%2C%22env%22%3A%7B%22VK_ACCESS_TOKEN%22%3A%22%24%7Binput%3Avk_token%7D%22%7D%2C%22inputs%22%3A%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22vk_token%22%2C%22description%22%3A%22VK%20access%20token%22%2C%22password%22%3Atrue%7D%5D%7D)

VS Code prompts for your VK token and keeps it out of the config file. From a
terminal instead:

```bash
code --add-mcp '{"name":"vk","command":"npx","args":["-y","vk-mcp-server"],"env":{"VK_ACCESS_TOKEN":"your_token"}}'
```

### npm

```bash
npx vk-mcp-server
```

Or install globally with `npm install -g vk-mcp-server`.

### MCP Registry

Also available in the official MCP Registry:
```
io.github.bulatko/vk
```

## Getting VK Access Token

1. Go to [VK Developers](https://vk.com/dev) and create a Standalone app
2. Get your app ID
3. Open this URL (replace `YOUR_APP_ID`):
   ```
   https://oauth.vk.com/authorize?client_id=YOUR_APP_ID&display=page&redirect_uri=https://oauth.vk.com/blank.html&scope=friends,wall,groups,photos,stats,offline&response_type=token&v=5.199
   ```
4. Authorize and copy the `access_token` from the URL

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "vk": {
      "command": "npx",
      "args": ["-y", "vk-mcp-server"],
      "env": {
        "VK_ACCESS_TOKEN": "your_access_token_here"
      }
    }
  }
}
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "vk": {
      "command": "npx",
      "args": ["-y", "vk-mcp-server"],
      "env": {
        "VK_ACCESS_TOKEN": "your_access_token_here"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VK_ACCESS_TOKEN` | yes | — | VK API access token |
| `VK_TIMEOUT_MS` | no | `30000` | Abort a VK request that hangs longer than this |
| `VK_API_BASE` | no | `https://api.vk.com/method` | Point the server at an API mirror or proxy |

VK rate-limits user tokens to a few calls per second. When it answers with
error 6 (*too many requests*), the server backs off and retries up to three
times before giving up, so short bursts of tool calls do not fail outright.

## Available Tools

Tools marked ✏️ change something on VK — they post, edit, delete or join on
behalf of whoever owns the access token. Each tool also carries MCP annotations
(`readOnlyHint`, `destructiveHint`), so a client can auto-approve lookups while
still asking before a post is edited or deleted.

### Users

| Tool | Description |
|------|-------------|
| `vk_users_get` | Get user profiles by IDs or screen names |
| `vk_users_search` | Search users by name, city, age and other criteria |

### Wall

| Tool | Description |
|------|-------------|
| `vk_wall_get` | Get posts from user/community wall |
| `vk_wall_get_by_id` | Get specific posts by `{owner_id}_{post_id}` |
| `vk_wall_post` | ✏️ Publish a new post |
| `vk_wall_edit` | ✏️ Edit an existing post |
| `vk_wall_delete` | ✏️ Delete a post |
| `vk_wall_create_comment` | ✏️ Add comment to a post |

### Groups

| Tool | Description |
|------|-------------|
| `vk_groups_get` | Get user's communities list |
| `vk_groups_get_by_id` | Get community info by ID |
| `vk_groups_search` | Search communities by name and criteria |
| `vk_groups_get_members` | Get community members |
| `vk_groups_join` | ✏️ Join a community or request to join |

### Photos

| Tool | Description |
|------|-------------|
| `vk_photos_get` | Get photos from albums |
| `vk_photos_upload_wall` | ✏️ Upload a photo and get an attachment string for `vk_wall_post` |

### Other

| Tool | Description |
|------|-------------|
| `vk_friends_get` | Get user's friends list |
| `vk_newsfeed_get` | Get user's newsfeed |
| `vk_likes_get` | Get users who liked an object, with reaction counts |
| `vk_stats_get` | Get community statistics (admin only) |

## Prompts

Prompts appear in your client as ready-made workflows — pick one, fill in the
community, and the model knows which tools to use.

| Prompt | What it does |
|--------|--------------|
| `community_digest` | Reads recent posts and summarises themes, standouts and cadence |
| `engagement_report` | Ranks posts by likes and by comments, then explains what the winners share |
| `audience_snapshot` | Samples members and describes the audience by sex, city and activity |
| `find_communities` | Searches communities on a topic and compares the candidates |

## Usage Examples

Once configured, you can ask Claude:

- "Get information about Pavel Durov's VK profile"
- "Show me the latest 5 posts from the VK official community"
- "Post 'Hello World!' on my wall"
- "Get the list of communities I'm a member of"
- "Show my newsfeed"

### Example Conversation

```
User: What's on Pavel Durov's wall?

Claude: I'll check Pavel Durov's VK wall for recent posts.
[Uses vk_wall_get with domain="durov"]

Here are the latest posts from Pavel Durov's wall:
1. [Post content...]
2. [Post content...]
```

## Testing

Run the test suite:

```bash
npm test
```

Run tests with coverage:

```bash
npm run test:coverage
```

## API Reference

This server wraps VK API v5.199. For detailed parameter documentation, see:
- [VK API Methods](https://dev.vk.com/ru/method)
- [VK API Objects](https://dev.vk.com/ru/reference)

## Security Notes

- Never share your access token
- The `offline` scope provides a non-expiring token
- Review permissions before authorizing
- For production, consider using a service token

## Contributing

Contributions are welcome! Please read the [Contributing Guidelines](CONTRIBUTING.md) first.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) © 2026 bulatko

## Links

- [npm Package](https://www.npmjs.com/package/vk-mcp-server)
- [MCP Registry](https://registry.modelcontextprotocol.io/)
- [VK API Documentation](https://dev.vk.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

---

<p align="center">Made with ❤️ for the MCP ecosystem</p>
