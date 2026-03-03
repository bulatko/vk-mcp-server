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

---

## Features

- **Read Operations**: Get users, wall posts, groups, friends, newsfeed, photos
- **Write Operations**: Create posts, add comments
- **Analytics**: Get community statistics
- **Secure**: Token-based authentication via environment variable
- **Tested**: Comprehensive test coverage
- **Easy Install**: Available on npm and MCP Registry

## Quick Start

### Installation

```bash
npm install -g vk-mcp-server
```

Or run directly with npx:
```bash
npx vk-mcp-server
```

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

## Available Tools

| Tool | Description |
|------|-------------|
| `vk_users_get` | Get user profiles by IDs or screen names |
| `vk_wall_get` | Get posts from user/community wall |
| `vk_wall_post` | Publish a new post |
| `vk_wall_create_comment` | Add comment to a post |
| `vk_groups_get` | Get user's communities list |
| `vk_groups_get_by_id` | Get community info by ID |
| `vk_friends_get` | Get user's friends list |
| `vk_newsfeed_get` | Get user's newsfeed |
| `vk_stats_get` | Get community statistics (admin only) |
| `vk_photos_get` | Get photos from albums |

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
