# Contributing to VK MCP Server

Thank you for your interest in contributing to VK MCP Server! This document provides guidelines and steps for contributing.

## Code of Conduct

Please be respectful and considerate in all interactions. We're all here to build something useful together.

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/bulatko/vk-mcp-server/issues)
2. If not, create a new issue with:
   - Clear title describing the problem
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Environment details (Node.js version, OS, etc.)

### Suggesting Features

1. Check existing issues for similar suggestions
2. Create a new issue with the `enhancement` label
3. Describe the feature and its use case
4. Explain why it would be useful

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Add tests if applicable
5. Run tests: `npm test`
6. Commit with clear message: `git commit -m 'feat: add new feature'`
7. Push to your fork: `git push origin feature/your-feature-name`
8. Open a Pull Request

### Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `test:` - Adding or updating tests
- `refactor:` - Code refactoring
- `chore:` - Maintenance tasks

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/vk-mcp-server.git
cd vk-mcp-server

# Install dependencies
npm install

# Run tests
npm test

# Run the server locally
VK_ACCESS_TOKEN=your_token npm start
```

### Adding New VK API Methods

1. Add the method to `VKClient` class in `src/index.js`
2. Add tool definition to the `tools` array
3. Add handler case in `handleToolCall` function
4. Add tests in `tests/` directory
5. Update README.md with the new tool

## Questions?

Feel free to open an issue with the `question` label.

Thank you for contributing! 🎉
